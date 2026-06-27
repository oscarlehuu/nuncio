import { useEffect, useRef, useState } from 'react';
import { Archive, FolderGit2, GitBranch, Pause, Send, Square } from 'lucide-react';
import type { Session, SessionEvent } from '../lib/api';
import { statusLabel } from '../lib/api';
import { projectDisplayName } from '../lib/projects';
import { FALLBACK_PROVIDERS, modelById, prettyModelName, type ModelProvider } from '../lib/model-providers';
import { StatusDot } from './status-dot';
import { Transcript } from './session-transcript';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export { Transcript, buildMessages } from './session-transcript';

interface SessionDetailProps {
  session: Session;
  events: SessionEvent[];
  providers?: ModelProvider[];
  onSteer: (message: string) => Promise<void>;
  onPause: () => Promise<void>;
  onArchive: () => Promise<void>;
  steering?: boolean;
  lifecycleBusy?: boolean;
}

export function SessionDetail({
  session,
  events,
  providers,
  onSteer,
  onPause,
  onArchive,
  steering,
  lifecycleBusy,
}: SessionDetailProps) {
  const [steerText, setSteerText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const streaming = session.status === 'RUNNING';
  const isRunning = session.status === 'RUNNING';
  const steerDisabled =
    session.status === 'RUNNING' || session.status === 'ARCHIVED' || steering || lifecycleBusy;
  const showHeaderPause = !isRunning && session.status !== 'PAUSED' && session.status !== 'ARCHIVED';
  const canArchive = session.status !== 'ARCHIVED';

  const catalog = providers && providers.length > 0 ? providers : FALLBACK_PROVIDERS;
  const entry = session.model ? modelById(catalog)[session.model] : undefined;
  const modelName = entry ? prettyModelName(entry.name) : (session.model ?? 'Default');
  const repoName = projectDisplayName(session.projectPath);
  const branchName = session.branch;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [session.id]);

  const handleSteer = async () => {
    const text = steerText.trim();
    if (!text || steerDisabled) return;
    await onSteer(text);
    setSteerText('');
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <section className="flex-1 flex flex-col min-h-0">
      <header className="shrink-0 flex items-center gap-3 px-4 md:px-5 py-3 border-b border-border bg-card/80 backdrop-blur min-h-[52px]">
        <div className="flex-1 min-w-0 font-medium truncate text-sm">{session.title}</div>
        {repoName && (
          <Badge variant="outline" className="gap-1.5 shrink-0 hidden sm:inline-flex">
            <FolderGit2 className="size-3" />
            {repoName}
          </Badge>
        )}
        {branchName && (
          <Badge variant="outline" className="gap-1.5 shrink-0 hidden md:inline-flex">
            <GitBranch className="size-3" />
            {branchName}
          </Badge>
        )}
        <Badge variant="secondary" className="gap-1.5 shrink-0">
          <StatusDot status={session.status} />
          {statusLabel(session.status)}
        </Badge>
        <TooltipProvider>
          <div className="flex items-center gap-1 shrink-0">
            {showHeaderPause && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void onPause()}
                    disabled={lifecycleBusy}
                    aria-label="Pause session"
                  >
                    <Pause />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Pause session</TooltipContent>
              </Tooltip>
            )}
            {canArchive && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void onArchive()}
                    disabled={lifecycleBusy}
                    aria-label="Archive session"
                  >
                    <Archive />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Archive session</TooltipContent>
              </Tooltip>
            )}
          </div>
        </TooltipProvider>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 md:px-8 min-h-0">
        <div className="max-w-[760px] mx-auto">
          <Transcript events={events} streaming={streaming} />
        </div>
      </div>

      <div className="shrink-0 px-4 md:px-5 pt-3 pb-4 md:pb-[18px] border-t border-border bg-card composer-wrap">
        <div className="max-w-[760px] mx-auto rounded-[10px] border border-border bg-secondary transition-shadow focus-within:ring-2 focus-within:ring-ring/50">
          <Textarea
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSteer();
              }
            }}
            disabled={steerDisabled}
            placeholder={
              session.status === 'ARCHIVED'
                ? 'Session archived — steering disabled'
                : session.status === 'RUNNING'
                  ? 'Agent is running — wait for idle or stop first…'
                  : 'Steer the agent — add context, change direction, ask a question…'
            }
            className="min-h-[48px] resize-none border-0 shadow-none bg-transparent focus-visible:ring-0 focus-visible:border-0"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <Badge variant="secondary" className="gap-1.5">
                <span className="size-1.5 rounded-full bg-primary" />
                {modelName}
              </Badge>
              {repoName && (
                <Badge variant="secondary" className="gap-1.5 max-w-[180px]">
                  <FolderGit2 className="size-3 shrink-0" />
                  <span className="truncate">{repoName}</span>
                </Badge>
              )}
            </div>
            {isRunning ? (
              <Button
                size="icon-lg"
                variant="destructive"
                aria-label="Stop session"
                onClick={() => void onPause()}
                disabled={lifecycleBusy}
                className="shrink-0"
              >
                <Square />
              </Button>
            ) : (
              <Button
                size="icon-lg"
                aria-label="Send"
                onClick={() => void handleSteer()}
                disabled={steerDisabled || !steerText.trim()}
                className="shrink-0"
              >
                <Send />
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
