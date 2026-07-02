export interface AuthStatus {
  authenticated: boolean;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status');
  if (!res.ok) {
    throw new Error(`Failed to check auth status (${res.status})`);
  }
  return (await res.json()) as AuthStatus;
}

export interface AuthTokenInfo {
  token: string;
  source: string;
}

/** Reads the server's access token (guarded route — caller must already be authenticated). */
export async function fetchAuthToken(): Promise<AuthTokenInfo> {
  const res = await fetch('/api/auth/token');
  if (!res.ok) throw new Error(`Failed to load access token (${res.status})`);
  return (await res.json()) as AuthTokenInfo;
}

/** Exchanges the access token for the HttpOnly auth cookie. Throws on a wrong token. */
export async function login(token: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.status === 401) {
    throw new Error('Invalid access token');
  }
  if (!res.ok) {
    throw new Error(`Login failed (${res.status})`);
  }
}
