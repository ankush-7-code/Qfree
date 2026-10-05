import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test gets a fresh module so the "last seen awake" timestamp starts at zero.
async function freshApi() {
  vi.resetModules();
  return import('../lib/api');
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const proxyTimeout = () => new Response('<html>504 Gateway Timeout</html>', { status: 504, headers: { 'Content-Type': 'text/html' } });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: Handler) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      return handler(url, init);
    }),
  );
  return calls;
}

describe('API client with a sleeping server', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for the server to wake, then retries a read', async () => {
    let awake = false;
    const calls = mockFetch((url) => {
      if (url.endsWith('/api/health')) {
        const res = awake ? json(200, { status: 'ok' }) : proxyTimeout();
        awake = true; // wakes after the first health check
        return res;
      }
      return awake ? json(200, { items: [1] }) : proxyTimeout();
    });
    const { api, onServerWaking } = await freshApi();
    const banner: boolean[] = [];
    onServerWaking((w) => banner.push(w));

    const result = api.get<{ items: number[] }>('/doctors');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ items: [1] });
    expect(calls.filter((c) => c.url.includes('/doctors'))).toHaveLength(2);
    expect(banner).toEqual([true, false]);
  });

  it('confirms the server is awake before sending a write, and sends it once', async () => {
    const calls = mockFetch((url) => (url.endsWith('/api/health') ? json(200, { status: 'ok' }) : json(201, { ok: true })));
    const { api } = await freshApi();
    await api.post('/auth/register', { email: 'a@b.c' });
    expect(calls.map((c) => `${c.method} ${c.url.replace(/.*\/api/, '')}`)).toEqual(['GET /health', 'POST /auth/register']);

    // Recently confirmed awake: the next write goes straight through.
    await api.post('/issues', {});
    expect(calls.at(-1)?.url).toContain('/issues');
    expect(calls.filter((c) => c.url.endsWith('/health'))).toHaveLength(1);
  });

  it('never sends a write while the server stays unreachable', async () => {
    const calls = mockFetch(() => proxyTimeout());
    const { api, errorMessage } = await freshApi();
    const result = api.post('/queues/q1/join').catch((e) => e);
    await vi.advanceTimersByTimeAsync(130_000);
    const err = await result;
    expect(errorMessage(err)).toMatch(/not reachable/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('passes real API errors through without waiting', async () => {
    const calls = mockFetch((url) =>
      url.endsWith('/api/health') ? json(200, { status: 'ok' }) : json(409, { error: { code: 'QUEUE_FULL', message: 'This queue is full' } }),
    );
    const { api, errorMessage } = await freshApi();
    const err = await api.post('/queues/q1/join').catch((e) => e);
    expect(errorMessage(err)).toBe('This queue is full');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});
