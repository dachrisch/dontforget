import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractDates } from './opencodeClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractDates', () => {
  it('creates a session, sends the prompt, and parses the JSON reply', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'ses_123' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          parts: [
            {
              type: 'text',
              text:
                'Here you go:\n{"events":[{"label":"Frühjahrsdult","startDate":"2026-04-11","endDate":"2026-05-11","sourceUrl":"https://auerdult.de"}]}',
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

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
      'https://opencode.lehel.xyz/api/session/ses_123/message',
      expect.objectContaining({ method: 'POST' })
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

  it('parses the JSON reply even when the model appends trailing commentary', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'ses_456' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          parts: [
            {
              type: 'text',
              text:
                '{"events":[{"label":"Jakobidult","startDate":"2026-07-25","endDate":"2026-08-03","sourceUrl":"https://muenchen.de"}]}\n\nNote: excluded {ongoing fairs} without a specific date.',
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const events = await extractDates('https://opencode.lehel.xyz', 'test-key', 'Auer Dult Munich', [
      { title: 'Jakobidult', url: 'https://muenchen.de', content: 'Summer dates' },
    ]);

    expect(events).toEqual([
      {
        label: 'Jakobidult',
        startDate: '2026-07-25',
        endDate: '2026-08-03',
        sourceUrl: 'https://muenchen.de',
      },
    ]);
  });
});