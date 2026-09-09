import { describe, it, expect, vi, afterEach } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

// opencodeClient.ts imports fetch/Agent from 'undici' directly (not the
// global fetch) — passing an Agent from the standalone `undici` package to
// Node's global fetch throws, since Node's built-in fetch is backed by its
// own differently-versioned internal copy of undici. So the mock must
// replace undici's own `fetch` export, not global fetch. vi.mock calls are
// hoisted above imports, so this takes effect before opencodeClient.ts
// (imported below) resolves its own `import { fetch } from 'undici'`.
vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});

import { extractDates, extractSeries, extractSeriesDates, MAX_SERIES } from './opencodeClient.js';

afterEach(() => {
  fetchMock.mockReset();
});

function sessionResponse(id: string) {
  return { ok: true, json: async () => ({ data: { id } }) };
}

function promptAckResponse() {
  return { ok: true, json: async () => ({ data: { id: 'msg_ack', delivery: 'steer' } }) };
}

function assistantMessageResponse(text: string) {
  return {
    ok: true,
    json: async () => ({
      data: [
        { type: 'assistant', finish: 'stop', content: [{ type: 'text', text }] },
        { type: 'user', text: 'the prompt' },
      ],
    }),
  };
}

describe('extractDates', () => {
  it('creates a session, sends the prompt, polls for the reply, and parses it', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_123'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(
        assistantMessageResponse(
          'Here you go:\n{"events":[{"label":"Frühjahrsdult","startDate":"2026-04-11","endDate":"2026-05-11","sourceUrl":"https://auerdult.de"}],"cadence":"yearly"}'
        )
      );

    const result = await extractDates(
      'https://code.lehel.xyz',
      'test-key',
      'Auer Dult Munich',
      [{ title: 'Auer Dult', url: 'https://auerdult.de', content: 'Spring dates' }]
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://code.lehel.xyz/api/session',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-Api-Key': 'test-key' }) })
    );
    // Pin a specific, still-listed model (glm-5.3-flash on opencode-go)
    // rather than relying on whatever opencode defaults to.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      model: { id: 'glm-5.3-flash', providerID: 'opencode-go' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://code.lehel.xyz/api/session/ses_123/prompt',
      expect.objectContaining({ method: 'POST' })
    );
    const promptBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(typeof promptBody.prompt.text).toBe('string');
    expect(promptBody.prompt.text).toMatch(/cadence/);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://code.lehel.xyz/api/session/ses_123/message',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Api-Key': 'test-key' }) })
    );
    expect(result).toEqual({
      events: [
        {
          label: 'Frühjahrsdult',
          startDate: '2026-04-11',
          endDate: '2026-05-11',
          sourceUrl: 'https://auerdult.de',
        },
      ],
      cadence: 'yearly',
    });
  });

  it('polls again while the reply is still pending, then parses it once complete', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_456'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ type: 'user', text: 'the prompt' }] }) })
      .mockResolvedValueOnce(
        assistantMessageResponse(
          '{"events":[{"label":"Jakobidult","startDate":"2026-07-25","endDate":"2026-08-03","sourceUrl":"https://muenchen.de"}],"cadence":null}\n\nNote: excluded {ongoing fairs} without a specific date.'
        )
      );
    vi.useFakeTimers();

    const promise = extractDates('https://code.lehel.xyz', 'test-key', 'Auer Dult Munich', [
      { title: 'Jakobidult', url: 'https://muenchen.de', content: 'Summer dates' },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      events: [
        {
          label: 'Jakobidult',
          startDate: '2026-07-25',
          endDate: '2026-08-03',
          sourceUrl: 'https://muenchen.de',
        },
      ],
      cadence: null,
    });
  });

  function generationErrorResponse(message: string) {
    return {
      ok: true,
      json: async () => ({
        data: [{ type: 'assistant', finish: 'error', content: [], error: { message } }],
      }),
    };
  }

  it('retries a transient failure and succeeds on the next attempt', async () => {
    fetchMock
      // Attempt 1: session + prompt succeed, generation errors out.
      .mockResolvedValueOnce(sessionResponse('ses_fail'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(generationErrorResponse('Upstream request failed: Endpoint is unavailable.'))
      // Attempt 2 (retry): a fresh session, succeeds fully.
      .mockResolvedValueOnce(sessionResponse('ses_retry'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(
        assistantMessageResponse(
          '{"events":[{"label":"Frühjahrsdult","startDate":"2026-04-11","endDate":"2026-04-11","sourceUrl":"https://auerdult.de"}],"cadence":"yearly"}'
        )
      );
    vi.useFakeTimers();

    const promise = extractDates('https://code.lehel.xyz', 'test-key', 'query', []);
    await vi.runAllTimersAsync();
    const result = await promise;

    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'https://code.lehel.xyz/api/session', expect.anything());
    expect(result).toEqual({
      events: [
        { label: 'Frühjahrsdult', startDate: '2026-04-11', endDate: '2026-04-11', sourceUrl: 'https://auerdult.de' },
      ],
      cadence: 'yearly',
    });
  });

  it('drops an invalid or missing cadence to null instead of failing', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_cad'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(
        assistantMessageResponse(
          '{"events":[{"label":"Mystery Fest","startDate":"2026-01-01","endDate":"2026-01-01","sourceUrl":"https://a.example"}],"cadence":"fortnightly"}'
        )
      );

    const result = await extractDates('https://code.lehel.xyz', 'test-key', 'query', []);
    expect(result).toEqual({
      events: [{ label: 'Mystery Fest', startDate: '2026-01-01', endDate: '2026-01-01', sourceUrl: 'https://a.example' }],
      cadence: null,
    });
  });

  it('increases the backoff delay before each successive retry', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_a'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(generationErrorResponse('Upstream request failed: Endpoint is unavailable.'))
      .mockResolvedValueOnce(sessionResponse('ses_b'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(generationErrorResponse('Upstream request failed: Endpoint is unavailable.'))
      .mockResolvedValueOnce(sessionResponse('ses_c'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(assistantMessageResponse('{"events":[],"cadence":null}'));
    vi.useFakeTimers();

    const promise = extractDates('https://code.lehel.xyz', 'test-key', 'query', []);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(3); // still waiting out attempt 1's 1s backoff

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(6); // attempt 2 fired at 1s, failed, now backing off

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(6); // still waiting out attempt 2's longer, 2s backoff

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(9); // attempt 3 fired at the 2s mark

    const result = await promise;
    vi.useRealTimers();
    expect(result).toEqual({ events: [], cadence: null });
  });

  it('falls back to the backup model after the primary model exhausts all its attempts', async () => {
    for (let i = 0; i < 3; i++) {
      fetchMock
        .mockResolvedValueOnce(sessionResponse(`ses_primary_${i}`))
        .mockResolvedValueOnce(promptAckResponse())
        .mockResolvedValueOnce(generationErrorResponse('Provider request failed with HTTP 429: rate limited'));
    }
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_fallback'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(assistantMessageResponse('{"events":[],"cadence":null}'));
    vi.useFakeTimers();

    const promise = extractDates('https://code.lehel.xyz', 'test-key', 'query', []);
    await vi.runAllTimersAsync();
    const result = await promise;

    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(JSON.parse(fetchMock.mock.calls[9][1].body)).toEqual({
      model: { id: 'antigravity-gemini-3-flash', providerID: 'google' },
    });
    expect(result).toEqual({ events: [], cadence: null });
  });

  it('throws the last error after exhausting all retry attempts on both models', async () => {
    for (let i = 0; i < 6; i++) {
      fetchMock
        .mockResolvedValueOnce(sessionResponse(`ses_${i}`))
        .mockResolvedValueOnce(promptAckResponse())
        .mockResolvedValueOnce(generationErrorResponse('Upstream request failed: Endpoint is unavailable.'));
    }
    vi.useFakeTimers();

    const promise = extractDates('https://code.lehel.xyz', 'test-key', 'query', []);
    const assertion = expect(promise).rejects.toThrow('Endpoint is unavailable');
    await vi.runAllTimersAsync();
    await assertion;

    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(18);
  });

  it('records a model metric per attempt and honors a custom models list', async () => {
    // Custom list = admin-configured registry; only "primary" is enabled.
    const models = [{ id: 'primary', providerID: 'opencode' }];
    const recordModelCall = vi.fn().mockResolvedValue(undefined);
    const metrics = { recordModelCall, recordSearchCall: vi.fn() };

    // First attempt fails, second succeeds.
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_1'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(generationErrorResponse('Upstream request failed: Endpoint is unavailable.'));
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_2'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(assistantMessageResponse('{"events":[],"cadence":null}'));
    vi.useFakeTimers();

    const promise = extractDates('https://code.lehel.xyz', 'test-key', 'query', [], { models, metrics });
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    // One failure (attempt 1) + one success (attempt 2), both for "primary".
    expect(recordModelCall).toHaveBeenCalledTimes(2);
    expect(recordModelCall.mock.calls[0][0]).toMatchObject({ modelId: 'primary', outcome: 'failure' });
    expect(recordModelCall.mock.calls[1][0]).toMatchObject({ modelId: 'primary', outcome: 'success' });
    // The custom list is what the client tried — no fallback model was used.
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
      model: { id: 'primary', providerID: 'opencode' },
    });
  });
});

describe('extractSeries', () => {
  it('sends a series-grouping prompt that first resolves what each series applies to', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_series'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(
        assistantMessageResponse(
          '{"series":[{"title":"Auer Dult","appliesTo":"Auer Dult, Munich","description":"Thrice-yearly fair","searchKeywords":"Auer Dult Munich Termine","sourceUrls":["https://auerdult.de"]}]}'
        )
      );

    const result = await extractSeries('https://code.lehel.xyz', 'test-key', 'events in munich', [
      { title: 'Auer Dult', url: 'https://auerdult.de', content: 'dates' },
    ]);

    const promptBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(promptBody.prompt.text).toMatch(/applies to/i);
    expect(promptBody.prompt.text).toMatch(/appliesTo/);
    expect(promptBody.prompt.text).toMatch(/searchKeywords/);
    expect(result).toEqual({
      series: [
        {
          title: 'Auer Dult',
          appliesTo: 'Auer Dult, Munich',
          description: 'Thrice-yearly fair',
          searchKeywords: 'Auer Dult Munich Termine',
          sourceUrls: ['https://auerdult.de'],
        },
      ],
    });
  });

  it('falls back to the title when the model omits appliesTo', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_fallback'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(
        assistantMessageResponse(
          '{"series":[{"title":"Oktoberfest","description":"Beer festival","searchKeywords":"Oktoberfest Munich dates","sourceUrls":["https://oktoberfest.de"]}]}'
        )
      );

    const result = await extractSeries('https://code.lehel.xyz', 'test-key', 'events in munich', [
      { title: 'Oktoberfest', url: 'https://oktoberfest.de', content: 'dates' },
    ]);

    expect(result.series[0].appliesTo).toBe('Oktoberfest');
  });

  it('dedupes by what the series applies to rather than the display title', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_dedupe'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(
        assistantMessageResponse(
          JSON.stringify({
            series: [
              { title: 'Auer Dult — Spring', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich', sourceUrls: ['https://a.example'] },
              { title: 'Auer Dult — Summer', appliesTo: 'Auer Dult, Munich', description: 'd', searchKeywords: 'Auer Dult Munich', sourceUrls: ['https://b.example'] },
              { title: 'Stadtfest Minden', appliesTo: 'Stadtfest Minden, Minden', description: 'd', searchKeywords: 'Stadtfest Minden Termine', sourceUrls: ['https://c.example'] },
            ],
          })
        )
      );

    const result = await extractSeries('https://code.lehel.xyz', 'test-key', 'events', []);
    expect(result.series.map(s => s.appliesTo)).toEqual(['Auer Dult, Munich', 'Stadtfest Minden, Minden']);
  });

  it('caps at MAX_SERIES and drops entries without title, keywords, or sources', async () => {
    const many = Array.from({ length: MAX_SERIES + 5 }, (_, i) => ({
      title: `Series ${i + 1}`,
      appliesTo: `Series ${i + 1}, Munich`,
      description: 'd',
      searchKeywords: `Series ${i + 1} Munich`,
      sourceUrls: ['https://example.com'],
    }));
    many.push(
      { title: '', appliesTo: '', description: 'no title', searchKeywords: 'x Munich', sourceUrls: ['https://example.com'] },
      { title: 'No keywords', appliesTo: 'No keywords, Munich', description: 'd', searchKeywords: '', sourceUrls: ['https://example.com'] },
      { title: 'No sources', appliesTo: 'No sources, Munich', description: 'd', searchKeywords: 'No sources Munich', sourceUrls: [] }
    );
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_cap'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(assistantMessageResponse(JSON.stringify({ series: many })));

    const result = await extractSeries('https://code.lehel.xyz', 'test-key', 'events in munich', []);
    expect(result.series).toHaveLength(MAX_SERIES);
    expect(result.series[0].title).toBe('Series 1');
  });

  it('returns an empty list when the model finds nothing', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_empty'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(assistantMessageResponse('{"series":[]}'));

    const result = await extractSeries('https://code.lehel.xyz', 'test-key', 'events in munich', []);
    expect(result).toEqual({ series: [] });
  });
});

describe('extractSeriesDates', () => {
  it('scopes the date lookup to what the series applies to and ignores other events', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_dates'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce(
        assistantMessageResponse(
          '{"events":[{"label":"Stadtfest Minden 2026","startDate":"2026-06-12","endDate":"2026-06-14","sourceUrl":"https://stadtfest-minden.de"}],"cadence":"yearly"}'
        )
      );

    const result = await extractSeriesDates(
      'https://code.lehel.xyz',
      'test-key',
      {
        title: 'Stadtfest Minden',
        appliesTo: 'Stadtfest Minden, Minden',
        description: 'Annual city festival in Minden',
        searchKeywords: 'Stadtfest Minden Termine',
      },
      [{ title: 'Stadtfest Minden', url: 'https://stadtfest-minden.de', content: 'dates plus other Minden events' }]
    );

    const promptBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(promptBody.prompt.text).toMatch(/Stadtfest Minden, Minden/);
    expect(promptBody.prompt.text).toMatch(/only concrete dates that are occurrences of THIS series/i);
    expect(promptBody.prompt.text).toMatch(/Ignore dates belonging to any other event/i);
    expect(result).toEqual({
      events: [
        {
          label: 'Stadtfest Minden 2026',
          startDate: '2026-06-12',
          endDate: '2026-06-14',
          sourceUrl: 'https://stadtfest-minden.de',
        },
      ],
      cadence: 'yearly',
    });
  });
});
