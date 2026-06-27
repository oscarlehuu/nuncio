import { useMemo, useState } from 'react';
import { Archive, ArrowLeft, FolderGit2, GitBranch, Pause, Send } from 'lucide-react';
import type { Session, SessionEvent } from '../lib/api';
import { statusLabel } from '../lib/api';
import { projectDisplayName } from '../lib/projects';
import { FALLBACK_PROVIDERS, modelById } from '../lib/model-providers';
import { StatusDot } from './status-dot';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface TranscriptProps {
  events: SessionEvent[];
  streaming?: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
}

export function Transcript({ events, streaming }: TranscriptProps) {
  const messages = useMemo(() => buildMessages(events), [events]);

  return (
    <div className="flex flex-col gap-5 py-4">
      {messages.map((msg, i) => (
        <div
          key={i}
          className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
        >
          {msg.role === 'assistant' && (
            <span className="text-[11px] text-muted-foreground px-1">Assistant</span>
          )}
          <div
            className={`max-w-[90%] px-3.5 py-2.5 rounded-[10px] text-[14px] leading-relaxed ${
              msg.role === 'user'
                ? 'bg-primary/10 text-primary border border-transparent rounded-[14px_14px_4px_14px]'
                : 'bg-transparent text-foreground'
            }`}
          >
            {msg.text}
            {msg.streaming && (
              <span className="inline-block w-2 h-4 ml-0.5 bg-primary animate-pulse align-middle" />
            )}
          </div>
        </div>
      ))}
      {streaming && messages.length === 0 && (
        <p className="text-muted-foreground text-sm px-2">Agent is thinking…</p>
      )}
    </div>
  );
}

function buildMessages(events: SessionEvent[]): Message[] {
  const out: Message[] = [];
  let assistantBuf = '';

  for (const event of events) {
    if (event.type === 'user_message') {
      flushAssistant(out, assistantBuf);
      assistantBuf = '';
      out.push({ role: 'user', text: String(event.payload.text ?? '') });
    }
    if (event.type === 'assistant_delta') {
      assistantBuf += String(event.payload.delta ?? '');
    }
    if (event.type === 'assistant_message') {
      assistantBuf = String(event.payload.text ?? assistantBuf);
      flushAssistant(out, assistantBuf);
      assistantBuf = '';
    }
    if (event.type === 'tool_start') {
      out.push({
        role: 'assistant',
        text: `▸ tool: ${String(event.payload.tool ?? 'unknown')}`,
      });
    }
    if (event.type === 'error') {
      out.push({ role: 'assistant', text: `Error: ${String(event.payload.message ?? 'unknown')}` });
    }
  }

  if (assistantBuf) {
    out.push({ role: 'assistant', text: assistantBuf, streaming: true });
  }

  return out;
}

function flushAssistant(out: Message[], text: string) {
  if (text.trim()) out.push({ role: 'assistant', text });
}

interface SessionDetailProps {
  session: Session;
  events: SessionEvent[];
  onBack: () => void;
  onSteer: (message: string) => Promise<void>;
  onPause: () => Promise<void>;
  onArchive: () => Promise<void>;
  steering?: boolean;
  lifecycleBusy?: boolean;
}

export function SessionDetail({
  session,
  events,
  onBack,
  onSteer,
  onPause,
  onArchive,
  steering,
  lifecycleBusy,
}: SessionDetailProps) {
  const [steerText, setSteerText] = useState('');
  const streaming = session.status === 'RUNNING';
  const steerDisabled =
    session.status === 'RUNNING' || session.status === 'ARCHIVED' || steering || lifecycleBusy;
  const canPause = session.status !== 'PAUSED' && session.status !== 'ARCHIVED';
  const canArchive = session.status !== 'ARCHIVED';

  const modelName = session.model
    ? modelById(FALLBACK_PROVIDERS)[session.model]?.name ?? session.model
    : 'Default';
  const repoName = projectDisplayName(session.projectPath);
  const branchName = session.branch;

  const handleSteer = async () => {
    const text = steerText.trim();
    if (!text || steerDisabled) return;
    await onSteer(text);
    setSteerText('');
  };

  return (
    <section className="flex-1 flex flex-col min-h-0">
      <header className="shrink-0 flex items-center gap-3 px-4 md:px-5 py-3 border-b border-border bg-card/80 backdrop-blur min-h-[52px]">
        <Button variant="ghost" size="sm" onClick={onBack} className="md:hidden gap-1">
          <ArrowLeft data-icon="inline-start" />
          Home
        </Button>
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
            {canPause && (
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

      <div className="flex-1 overflow-y-auto px-4 md:px-8 min-h-0">
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
                  ? 'Agent is running — wait for idle or pause first…'
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
            <Button
              size="icon-lg"
              aria-label="Send"
              onClick={() => void handleSteer()}
              disabled={steerDisabled || !steerText.trim()}
              className="shrink-0"
            >
              <Send />
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
