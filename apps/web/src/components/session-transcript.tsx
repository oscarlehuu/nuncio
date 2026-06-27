import { Fragment, useMemo } from 'react';
import type { SessionEvent } from '../lib/api';
import { useThrottledStreamText } from '../lib/use-throttled-stream-text';
import { cn } from '../lib/utils';

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
}

interface TranscriptProps {
  events: SessionEvent[];
  streaming?: boolean;
}

export function buildMessages(events: SessionEvent[]): Message[] {
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

function StreamingAssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  const displayed = useThrottledStreamText(text, streaming);
  return (
    <>
      {displayed}
      {streaming && (
        <span className="inline-block w-2 h-4 ml-0.5 bg-primary animate-pulse align-middle" />
      )}
    </>
  );
}

export function WorkingIndicator({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground"
      data-testid="working-indicator"
    >
      <span className="size-2 rounded-full bg-primary animate-pulse shrink-0" />
      <span>{label}</span>
    </div>
  );
}

export function Transcript({ events, streaming }: TranscriptProps) {
  const messages = useMemo(() => buildMessages(events), [events]);
  const isWriting = streaming && messages.some((m) => m.streaming);

  const indicatorLabel = isWriting ? 'Nuncio is writing…' : 'Nuncio is working…';

  // Place the working indicator right after the last user message (so it sits
  // BELOW the user's prompt, before any assistant deltas). When there is no
  // user message, fall back to the end of the transcript.
  const indicatorIndex = useMemo(() => {
    if (!streaming) return -1;
    let lastUser = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') lastUser = i;
    }
    return lastUser === -1 ? messages.length : lastUser + 1;
  }, [messages, streaming]);

  return (
    <div className="flex flex-col gap-5 py-4">
      {messages.map((msg, i) => (
        <Fragment key={i}>
          {i === indicatorIndex && <WorkingIndicator label={indicatorLabel} />}
          <div
            className={cn(
              'flex flex-col gap-1',
              msg.role === 'user' ? 'items-end' : 'items-start',
            )}
          >
            {msg.role === 'assistant' && (
              <span className="text-[11px] text-muted-foreground px-1">Assistant</span>
            )}
            <div
              className={cn(
                'max-w-[90%] px-3.5 py-2.5 rounded-[10px] text-[14px] leading-relaxed',
                msg.role === 'user'
                  ? 'bg-primary/10 text-primary border border-transparent rounded-[14px_14px_4px_14px]'
                  : 'bg-transparent text-foreground',
              )}
            >
              {msg.role === 'assistant' && msg.streaming ? (
                <StreamingAssistantText text={msg.text} streaming={streaming ?? false} />
              ) : (
                msg.text
              )}
            </div>
          </div>
        </Fragment>
      ))}
      {streaming && indicatorIndex >= messages.length && (
        <WorkingIndicator label={indicatorLabel} />
      )}
    </div>
  );
}
