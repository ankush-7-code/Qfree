/**
 * Thin fetch wrapper. The access token lives in memory only (never localStorage);
 * the refresh token is an httpOnly cookie. On a 401 the client refreshes once and retries.
 */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
const listeners = new Set<(token: string | null) => void>();

export const getAccessToken = () => accessToken;
export function setAccessToken(token: string | null) {
  accessToken = token;
  listeners.forEach((l) => l(token));
}
export function onTokenChange(listener: (token: string | null) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ─── Server wake-up ───
// The API's free hosting sleeps when idle and takes up to a minute to wake. Reads wait for it and
// retry. Writes are only sent once the server is known to be awake: a write that times out at the
// proxy may still be executed after the server wakes, so resending it could duplicate it.

const UNAVAILABLE_MESSAGE = 'The QFree server is not reachable right now. Please check your connection and try again.';
const AWAKE_WINDOW_MS = 4 * 60_000; // the server sleeps after 15 idle minutes
const WAKE_TIMEOUT_MS = 120_000;
const BANNER_DELAY_MS = 1_500;

let lastOkAt = 0;
let waking: Promise<boolean> | null = null;
const wakeListeners = new Set<(waking: boolean) => void>();

const unavailable = (status = 0) => new ApiError(status, 'SERVER_UNAVAILABLE', UNAVAILABLE_MESSAGE);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Subscribe to "waiting for the server to wake up" (true) / "done waiting" (false). */
export function onServerWaking(listener: (waking: boolean) => void) {
  wakeListeners.add(listener);
  return () => {
    wakeListeners.delete(listener);
  };
}

async function ping() {
  try {
    const res = await fetch(`${API_URL}/api/health`, { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    return res.ok && body?.status === 'ok';
  } catch {
    return false;
  }
}

/** Resolves true once the API answers its health check (polling while it wakes), false after two minutes. */
export function waitForServer(): Promise<boolean> {
  waking ??= (async () => {
    let shown = false;
    const banner = setTimeout(() => {
      shown = true;
      wakeListeners.forEach((l) => l(true));
    }, BANNER_DELAY_MS);
    try {
      const deadline = Date.now() + WAKE_TIMEOUT_MS;
      do {
        if (await ping()) {
          lastOkAt = Date.now();
          return true;
        }
        await sleep(3_000);
      } while (Date.now() < deadline);
      return false;
    } finally {
      clearTimeout(banner);
      if (shown) wakeListeners.forEach((l) => l(false));
      waking = null;
    }
  })();
  return waking;
}

const ensureAwake = () => (Date.now() - lastOkAt < AWAKE_WINDOW_MS ? Promise.resolve(true) : waitForServer());

let refreshing: Promise<unknown> | null = null;

/** Exchange the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession<T = unknown>(): Promise<T> {
  const attempt = async (retry: boolean): Promise<unknown> => {
    if (!(await ensureAwake())) throw unavailable();
    const res = await fetch(`${API_URL}/api/auth/refresh`, { method: 'POST', credentials: 'include' }).catch(() => null);
    if (!res) throw unavailable();
    const body = await res.json().catch(() => null);
    if (!body?.error && !res.ok) throw unavailable(res.status);
    lastOkAt = Date.now();
    // Another tab rotated the cookie a moment ago; the browser now holds the new one.
    if (res.status === 401 && body?.error?.code === 'REFRESH_RACE' && retry) {
      await sleep(300);
      return attempt(false);
    }
    if (!res.ok) {
      setAccessToken(null);
      throw new ApiError(res.status, body?.error?.code ?? 'UNAUTHORIZED', body?.error?.message ?? 'Session expired');
    }
    setAccessToken(body.accessToken);
    return body;
  };
  refreshing ??= attempt(true).finally(() => {
    refreshing = null;
  });
  return refreshing as Promise<T>;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Query;
  retry?: boolean;
  /** Internal: false once a read has already waited for the server to wake. */
  wake?: boolean;
}

export function qs(query?: Query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const isRead = method === 'GET';
  if (!isRead && !(await ensureAwake())) throw unavailable();

  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  // A read that hits a sleeping (or briefly unreachable) server waits for it, then tries once more.
  const retryRead = async () => {
    if (isRead && opts.wake !== false && (await waitForServer())) return request<T>(path, { ...opts, wake: false });
    throw unavailable();
  };

  const res = await fetch(`${API_URL}/api${path}${qs(opts.query)}`, {
    method,
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }).catch(() => null);
  if (!res) return retryRead();

  if (res.status === 401 && opts.retry !== false && !path.startsWith('/auth/')) {
    try {
      await refreshSession();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SERVER_UNAVAILABLE') throw err;
      throw new ApiError(401, 'UNAUTHORIZED', 'Your session has expired. Please sign in again.');
    }
    return request<T>(path, { ...opts, retry: false });
  }

  if (res.status === 204) {
    lastOkAt = Date.now();
    return undefined as T;
  }
  const body = await res.json().catch(() => null);
  // No QFree error body means the reply came from the proxy or host, not the API itself.
  if (!res.ok && !body?.error) return retryRead();
  lastOkAt = Date.now();
  if (!res.ok) {
    throw new ApiError(res.status, body.error.code ?? 'ERROR', body.error.message ?? `Request failed (${res.status})`, body.error.details);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Human-readable message from any thrown value, including field-level validation errors. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const fields = (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors;
    const first = fields && Object.entries(fields).find(([, v]) => v?.length);
    return first ? `${first[0]}: ${first[1][0]}` : err.message;
  }
  if (err instanceof Error) return err.message.includes('fetch') ? UNAVAILABLE_MESSAGE : err.message;
  return 'Something went wrong';
}
