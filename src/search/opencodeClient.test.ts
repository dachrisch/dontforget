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

import { extractDates } from './opencodeClient.js';

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
    // opencode's own default model (picked when none is specified) is an
    // unreliable free tier prone to persistent 503s — confirmed live
    // 2026-08-10. Pin a specific, verified-working model explicitly.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      model: { id: 'mimo-v2.5-free', providerID: 'opencode' },
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
      model: { id: 'big-pickle', providerID: 'opencode' },
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
