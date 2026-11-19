// Browser API client. Sessions live in memory only (never localStorage), so
// closing the tab signs the voter out. Retries are automatic and safe because
// every write endpoint is idempotent.
export class ApiError extends Error {
  status: number; body: any;
  constructor(status: number, body: any) { super(body?.error ?? `Request failed (${status})`); this.status = status; this.body = body; }
}

type Listener = (s: { waiting: boolean; offline: boolean; position?: number }) => void;
const listeners = new Set<Listener>();
export const onNetworkState = (l: Listener) => { listeners.add(l); return () => listeners.delete(l); };
const emit = (s: { waiting: boolean; offline: boolean; position?: number }) => listeners.forEach((l) => l(s));

let session: string | null = null;
export const setSession = (s: string | null) => { session = s; };
export const hasSession = () => !!session;

export async function api(path: string, opts: { body?: unknown; method?: string; auth?: boolean; maxAttempts?: number } = {}) {
  const maxAttempts = opts.maxAttempts ?? 30;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(path, {
        method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json', ...(opts.auth !== false && session ? { authorization: `Bearer ${session}` } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      // Network down: tell the user, wait, retry the SAME request.
      emit({ waiting: false, offline: true });
      if (attempt >= maxAttempts) throw new ApiError(0, { error: 'No internet connection. Your vote has not been lost; please try again when you are connected.' });
      await sleep(Math.min(15000, 1000 * attempt));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 503 || (res.status >= 500 && body.retryable)) {
      emit({ waiting: true, offline: false, position: body.position });
      if (attempt >= maxAttempts) throw new ApiError(res.status, body);
      await sleep(Math.min(15000, (body.retryAfterSeconds ?? 2) * 1000) * (0.5 + Math.random()));
      continue;
    }
    emit({ waiting: false, offline: false });
    if (!res.ok) throw new ApiError(res.status, body);
    return body;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
