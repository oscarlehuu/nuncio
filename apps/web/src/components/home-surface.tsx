import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { AttentionQueue } from './attention-queue';
import { DigestCard } from './digest-card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface HomeSurfaceProps {
  /** Start a new agent; the composer lives at /new. */
  onNew: () => void;
  /** True when the unpinned desktop sidebar rail overlays the content's left edge. */
  railOverlay?: boolean;
}

/** Home is the founder's digest plus the ranked queue of work needing attention. */
export function HomeSurface({ onNew, railOverlay = true }: HomeSurfaceProps) {
  const navigate = useNavigate();

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header
        className={cn(
          'flex items-center gap-2 px-4 py-3 pl-16 border-b border-border sticky top-0 bg-background/80 backdrop-blur z-10 md:pl-4',
          railOverlay && 'md:pl-16',
        )}
      >
        <h1 className="text-lg font-semibold tracking-tight">Home</h1>
        <div className="ml-auto">
          <Button size="sm" className="gap-1.5" onClick={onNew}>
            <Plus className="size-4" />
            <span>New agent</span>
            <kbd
              aria-hidden
              className="hidden rounded border border-primary-foreground/30 px-1 font-mono text-[0.65rem] sm:inline"
            >
              ⌘N
            </kbd>
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
          <DigestCard onOpen={() => navigate('/digest')} />
          <AttentionQueue compactEmpty />
        </div>
      </div>
    </section>
  );
}
