import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2, PlayCircle } from 'lucide-react';
import { createSessionFromPull, type ForgeCapabilitiesDto } from '../../lib/forge-api';
import { Button } from '../ui/button';

interface PrOpenSessionButtonProps {
  path: string;
  number: number;
  capabilities: ForgeCapabilitiesDto | null;
}

/**
 * Adopt this pull request into a working session and jump to it. When one is
 * already active for the PR the server returns that session, so this never
 * duplicates. Only GitHub and GitLab support worktree adoption — for anything
 * else the button renders disabled with the reason rather than failing on tap.
 */
export function PrOpenSessionButton({ path, number, capabilities }: PrOpenSessionButtonProps) {
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);

  const provider = capabilities?.provider ?? null;
  const supported = provider === 'github' || provider === 'gitlab';
  // Capabilities still loading — keep the button live but let the request decide.
  const known = capabilities !== null;
  const reason = known && !supported ? 'Only GitHub and GitLab pull requests can open a session.' : null;
  const disabled = opening || reason !== null;

  const handleOpen = async () => {
    if (disabled) return;
    try {
      setOpening(true);
      const { sessionId } = await createSessionFromPull(path, number);
      navigate(`/session/${sessionId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open a session for this pull request');
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {reason && <span className="text-xs text-muted-foreground">{reason}</span>}
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        onClick={() => void handleOpen()}
        disabled={disabled}
        title={reason ?? undefined}
        aria-label={`Open a session for pull request #${number}`}
      >
        {opening ? <Loader2 className="size-3.5 animate-spin" /> : <PlayCircle className="size-3.5" />}
        {opening ? 'Opening session…' : 'Open in session'}
      </Button>
    </div>
  );
}
