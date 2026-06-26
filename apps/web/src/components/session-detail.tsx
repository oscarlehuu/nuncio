import { useMemo, useState } from 'react';
import type { Session, SessionEvent } from '../lib/api';
import { statusLabel } from '../lib/api';
import { FALLBACK_PROVIDERS, modelById } from '../lib/model-providers';
import { StatusDot } from './status-dot';

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
        <div key={i} className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
          {msg.role === 'assistant' && (
            <span className="text-[11px] text-text-2 px-1">Assistant</span>
          )}
          <div
            className={`max-w-[90%] px-3.5 py-2.5 rounded-[10px] text-[14px] leading-relaxed ${
              msg.role === 'user'
                ? 'bg-accent-soft text-accent border border-transparent rounded-[14px_14px_4px_14px]'
                : 'bg-transparent text-text-0'
            }`}
          >
            {msg.text}
            {msg.streaming && <span className="inline-block w-2 h-4 ml-0.5 bg-accent animate-pulse align-middle" />}
          </div>
        </div>
      ))}
      {streaming && messages.length === 0 && (
        <p className="text-text-2 text-sm px-2">Agent is thinking…</p>
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

  const handleSteer = async () => {
    const text = steerText.trim();
    if (!text || steerDisabled) return;
    await onSteer(text);
    setSteerText('');
  };

  return (
    <section className="flex-1 flex flex-col min-h-0">
      <header className="shrink-0 flex items-center gap-3 px-4 md:px-5 py-3 border-b border-border-soft bg-bg-1/80 backdrop-blur min-h-[52px]">
        <button type="button" onClick={onBack} className="md:hidden text-text-1 text-sm flex items-center gap-1">
          ← Home
        </button>
        <div className="flex-1 min-w-0 font-medium truncate text-sm">{session.title}</div>
        <div className="flex items-center gap-1.5 text-[11.5px] text-text-1 shrink-0 px-2 py-0.5 rounded-full bg-bg-2">
          <StatusDot status={session.status} />
          {statusLabel(session.status)}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {canPause && (
            <button
              type="button"
              onClick={() => void onPause()}
              disabled={lifecycleBusy}
              title="Pause session"
              className="p-2 rounded-md text-text-1 hover:bg-bg-2 disabled:opacity-40"
            >
              <PauseIcon />
            </button>
          )}
          {canArchive && (
            <button
              type="button"
              onClick={() => void onArchive()}
              disabled={lifecycleBusy}
              title="Archive session"
              className="p-2 rounded-md text-text-1 hover:bg-bg-2 disabled:opacity-40"
            >
              <ArchiveIcon />
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-8 min-h-0">
        <div className="max-w-[760px] mx-auto">
          <Transcript events={events} streaming={streaming} />
        </div>
      </div>

      <div className="shrink-0 px-4 md:px-5 pt-3 pb-4 md:pb-[18px] border-t border-border-soft bg-bg-1 composer-wrap">
        <div className="max-w-[760px] mx-auto bg-bg-2 border border-border rounded-[10px] focus-within:border-accent transition-colors">
          <textarea
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
            rows={1}
            className="w-full bg-transparent px-4 pt-3.5 pb-1.5 resize-none outline-none text-sm placeholder:text-text-3 disabled:opacity-50 min-h-[48px]"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-bg-1 border border-border-soft rounded-md text-xs text-text-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              {modelName}
            </span>
            <button
              type="button"
              onClick={() => void handleSteer()}
              disabled={steerDisabled || !steerText.trim()}
              className="touch-target w-9 h-9 rounded-lg bg-accent text-[#1a1208] flex items-center justify-center disabled:opacity-40 hover:bg-accent-hover transition-colors shrink-0"
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}
