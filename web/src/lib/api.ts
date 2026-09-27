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

let refreshing: Promise<unknown> | null = null;

/** Exchange the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession<T = unknown>(): Promise<T> {
  const attempt = (retry: boolean): Promise<unknown> =>
    fetch(`${API_URL}/api/auth/refresh`, { method: 'POST', credentials: 'include' }).then(async (res) => {
      const body = await res.json().catch(() => ({}));
      // Another tab rotated the cookie a moment ago; the browser now holds the new one.
      if (res.status === 401 && body?.error?.code === 'REFRESH_RACE' && retry) {
        await new Promise((r) => setTimeout(r, 300));
        return attempt(false);
      }
      if (!res.ok) {
        setAccessToken(null);
        throw new ApiError(res.status, body?.error?.code ?? 'UNAUTHORIZED', body?.error?.message ?? 'Session expired');
      }
      setAccessToken(body.accessToken);
      return body;
    });
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
}

export function qs(query?: Query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${API_URL}/api${path}${qs(opts.query)}`, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401 && opts.retry !== false && !path.startsWith('/auth/')) {
    try {
      await refreshSession();
    } catch {
      throw new ApiError(401, 'UNAUTHORIZED', 'Your session has expired. Please sign in again.');
    }
    return request<T>(path, { ...opts, retry: false });
  }

  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // No QFree error body means the reply came from a proxy or host, not the API itself
    // (API not deployed, or a free-tier server still waking up).
    if (!body?.error) {
      throw new ApiError(res.status, 'SERVER_UNAVAILABLE', 'The QFree server is not reachable right now. It may be starting up — please try again in a minute.');
    }
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
  if (err instanceof Error) return err.message.includes('fetch') ? 'Cannot reach the server. Check your connection.' : err.message;
  return 'Something went wrong';
}
