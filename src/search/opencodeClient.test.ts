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
          'Here you go:\n{"events":[{"label":"Frühjahrsdult","startDate":"2026-04-11","endDate":"2026-05-11","sourceUrl":"https://auerdult.de"}]}'
        )
      );

    const events = await extractDates(
      'https://opencode.lehel.xyz',
      'test-key',
      'Auer Dult Munich',
      [{ title: 'Auer Dult', url: 'https://auerdult.de', content: 'Spring dates' }]
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://opencode.lehel.xyz/api/session',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-Api-Key': 'test-key' }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://opencode.lehel.xyz/api/session/ses_123/prompt',
      expect.objectContaining({ method: 'POST' })
    );
    const promptBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(typeof promptBody.prompt.text).toBe('string');
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://opencode.lehel.xyz/api/session/ses_123/message',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Api-Key': 'test-key' }) })
    );
    expect(events).toEqual([
      {
        label: 'Frühjahrsdult',
        startDate: '2026-04-11',
        endDate: '2026-05-11',
        sourceUrl: 'https://auerdult.de',
      },
    ]);
  });

  it('polls again while the reply is still pending, then parses it once complete', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_456'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ type: 'user', text: 'the prompt' }] }) })
      .mockResolvedValueOnce(
        assistantMessageResponse(
          '{"events":[{"label":"Jakobidult","startDate":"2026-07-25","endDate":"2026-08-03","sourceUrl":"https://muenchen.de"}]}\n\nNote: excluded {ongoing fairs} without a specific date.'
        )
      );
    vi.useFakeTimers();

    const promise = extractDates('https://opencode.lehel.xyz', 'test-key', 'Auer Dult Munich', [
      { title: 'Jakobidult', url: 'https://muenchen.de', content: 'Summer dates' },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    const events = await promise;

    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(events).toEqual([
      {
        label: 'Jakobidult',
        startDate: '2026-07-25',
        endDate: '2026-08-03',
        sourceUrl: 'https://muenchen.de',
      },
    ]);
  });

  it('throws with the upstream message when generation finishes with an error', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionResponse('ses_789'))
      .mockResolvedValueOnce(promptAckResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              type: 'assistant',
              finish: 'error',
              content: [],
              error: { message: 'Upstream request failed: Endpoint is unavailable.' },
            },
          ],
        }),
      });

    await expect(
      extractDates('https://opencode.lehel.xyz', 'test-key', 'query', [])
    ).rejects.toThrow('Endpoint is unavailable');
  });
});
