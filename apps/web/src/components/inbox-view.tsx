import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DigestCard } from './digest-card';
import { AttentionQueue } from './attention-queue';
import { Button } from '@/components/ui/button';

interface InboxViewProps {
  onBack: () => void;
}

/**
 * The Inbox — ONE ranked queue of everything needing the founder (rung 3). The
 * server ranks by severity → project → age, so items render in the order received
 * (no client re-sort; acked items stay muted in place). Polls while mounted so a
 * newly-raised item or a cleared condition shows without a manual refresh.
 */
export function InboxView({ onBack }: InboxViewProps) {
  const navigate = useNavigate();

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background z-10">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Inbox</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-[720px]">
          {/* Today's digest — a peer entry point that shares the Inbox's rhythm.
              Self-hides until a digest exists, so it never disrupts the empty state. */}
          <DigestCard onOpen={() => navigate('/digest')} />
          <AttentionQueue />
        </div>
      </div>
    </section>
  );
}
