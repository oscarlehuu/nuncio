import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { fetchAuthStatus, login } from '../lib/auth-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type GateState = 'checking' | 'locked' | 'ready';

/**
 * Blocks the app behind the server access token for remote (non-loopback)
 * clients. Loopback clients report authenticated immediately, so local use
 * never sees this screen. If the status check itself fails (server down),
 * the gate renders the app and lets it surface its own connection errors.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAuthStatus()
      .then((status) => {
        if (!cancelled) setState(status.authenticated ? 'ready' : 'locked');
      })
      .catch(() => {
        if (!cancelled) setState('ready');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const value = token.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(value);
      setState('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (state === 'ready') {
    return <>{children}</>;
  }
  if (state === 'checking') {
    return null;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm"
      >
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">Nuncio</h1>
          <p className="text-sm text-muted-foreground">
            This server requires an access token. It is printed when the server starts and stored
            as <code className="font-mono">auth-token</code> in the server&apos;s data directory.
          </p>
        </div>
        <Input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Access token"
          aria-label="Access token"
          autoFocus
        />
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={!token.trim() || submitting}>
          {submitting ? 'Connecting…' : 'Connect'}
        </Button>
      </form>
    </div>
  );
}
