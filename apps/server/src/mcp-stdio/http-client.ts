export class DaemonApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonApiError';
  }
}

export interface DaemonApiClientOptions {
  apiOrigin: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

export class DaemonApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DaemonApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get(path: string, query?: Record<string, unknown>): Promise<unknown> {
    return this.request('GET', path, undefined, query);
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchImpl(this.url(path, query), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.options.authToken ? { Authorization: `Bearer ${this.options.authToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new DaemonApiError(readErrorMessage(payload, response.statusText));
    if (hasErrorString(payload)) throw new DaemonApiError(payload.error);
    return payload;
  }

  private url(path: string, query?: Record<string, unknown>): string {
    const base = this.options.apiOrigin.replace(/\/$/, '');
    const apiPath = base.endsWith('/api') && path.startsWith('/api/') ? path.slice(4) : path;
    const url = new URL(`${base}${apiPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function hasErrorString(value: unknown): value is { error: string } {
  return typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string';
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload;
  if (hasErrorString(payload)) return payload.error;
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return fallback || 'daemon request failed';
}
