import type { MessageAttachment } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';
import type { ModelOptionsMap } from '../lib/model-options';
import { Clock3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AttentionQueue } from './attention-queue';
import { HomeDigestLine } from './home-digest-line';
import { HomeView } from './home-view';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface HomeSurfaceProps {
  sessionCount: number;
  providers?: ModelProvider[];
  onSubmit: (
    prompt: string,
    model?: string,
    provider?: string,
    projectPath?: string,
    baseBranch?: string,
    modelOptions?: ModelOptionsMap,
    useWorktree?: boolean,
    attachments?: MessageAttachment[],
  ) => Promise<void>;
  onContinueOnMobile?: () => void;
  loading?: boolean;
  /** Increment to focus the composer (the new-agent shortcut). */
  composerFocusKey?: number;
  /** True when the unpinned desktop sidebar rail overlays the content's left edge. */
  railOverlay?: boolean;
}

/** Home: the composer on top, then one digest line and the ranked attention queue. */
export function HomeSurface({
  sessionCount,
  providers,
  onSubmit,
  onContinueOnMobile,
  loading,
  composerFocusKey,
  railOverlay = true,
}: HomeSurfaceProps) {
  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header
        className={cn(
          'app-region-drag flex items-center gap-2 px-4 py-3 pl-16 border-b border-border sticky top-0 bg-background z-10 md:pl-4',
          railOverlay && 'md:pl-16',
        )}
      >
        <h1 className="text-lg font-semibold tracking-tight">Home</h1>
        <Button asChild variant="ghost" size="sm" className="app-region-no-drag ml-auto gap-1.5 text-muted-foreground">
          <Link to="/timeline">
            <Clock3 className="size-3.5" />
            Timeline
          </Link>
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
          <HomeView
            inline
            focusKey={composerFocusKey}
            sessionCount={sessionCount}
            providers={providers}
            onSubmit={onSubmit}
            onContinueOnMobile={onContinueOnMobile}
            loading={loading}
          />
          <HomeDigestLine />
          <AttentionQueue compactEmpty />
        </div>
      </div>
    </section>
  );
}
