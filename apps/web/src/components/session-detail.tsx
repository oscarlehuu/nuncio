import { useMemo } from 'react';
import type { Session, SessionEvent } from '../lib/api';
import { statusLabel } from '../lib/api';
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
                ? 'bg-bg-3 text-text-0'
                : 'bg-bg-2 border border-border-soft text-text-0'
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
}

export function SessionDetail({ session, events, onBack }: SessionDetailProps) {
  const streaming = session.status === 'RUNNING';

  return (
    <section className="flex-1 flex flex-col min-h-0">
      <header className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border-soft bg-bg-1/80 backdrop-blur">
        <button type="button" onClick={onBack} className="md:hidden text-text-1 text-sm">
          ← Home
        </button>
        <div className="flex-1 min-w-0 font-medium truncate">{session.title}</div>
        <div className="flex items-center gap-2 text-xs text-text-1 shrink-0">
          <StatusDot status={session.status} />
          {statusLabel(session.status)}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-8 min-h-0">
        <div className="max-w-[720px] mx-auto">
          <Transcript events={events} streaming={streaming} />
        </div>
      </div>
    </section>
  );
}
