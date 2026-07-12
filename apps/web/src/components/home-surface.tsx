import { useNavigate } from 'react-router-dom';
import type { MessageAttachment } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';
import type { ModelOptionsMap } from '../lib/model-options';
import { AttentionQueue } from './attention-queue';
import { DigestCard } from './digest-card';
import { HomeView } from './home-view';
import { RecentCrewRuns } from './crew/recent-crew-runs';
import { cn } from '@/lib/utils';

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
  onCrewCreated?: (taskId: string) => void;
  /** Increment to focus the composer (the new-agent shortcut). */
  composerFocusKey?: number;
  /** True when the unpinned desktop sidebar rail overlays the content's left edge. */
  railOverlay?: boolean;
}

/** Home: the composer on top, then the digest and the ranked attention queue. */
export function HomeSurface({
  sessionCount,
  providers,
  onSubmit,
  onContinueOnMobile,
  loading,
  onCrewCreated,
  composerFocusKey,
  railOverlay = true,
}: HomeSurfaceProps) {
  const navigate = useNavigate();

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header
        className={cn(
          'flex items-center gap-2 px-4 py-3 pl-16 border-b border-border sticky top-0 bg-background z-10 md:pl-4',
          railOverlay && 'md:pl-16',
        )}
      >
        <h1 className="text-lg font-semibold tracking-tight">Home</h1>
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
            onCrewCreated={onCrewCreated}
          />
          <RecentCrewRuns />
          <DigestCard onOpen={() => navigate('/digest')} />
          <AttentionQueue compactEmpty />
        </div>
      </div>
    </section>
  );
}
