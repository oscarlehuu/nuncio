import { Fragment, useMemo } from 'react';
import type { ProviderRequestDecision, SessionEvent } from '../lib/api';
import { useThrottledStreamText } from '../lib/use-throttled-stream-text';
import { cn } from '../lib/utils';
import { ProviderRequestCard, type ProviderRequestView } from './provider-request-card';

export interface Message {
  kind: 'message';
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
}

type TranscriptItem = Message | ProviderRequestView;

interface TranscriptProps {
  events: SessionEvent[];
  streaming?: boolean;
  respondingRequestId?: string | null;
  onRespondProviderRequest?: (
    requestId: string,
    decision: ProviderRequestDecision,
  ) => void | Promise<void>;
}

export function buildMessages(events: SessionEvent[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const requests = new Map<string, ProviderRequestView>();
  let assistantBuf = '';

  for (const event of events) {
    if (event.type === 'user_message') {
      flushAssistant(out, assistantBuf);
      assistantBuf = '';
      out.push({ kind: 'message', role: 'user', text: String(event.payload.text ?? '') });
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
        kind: 'message',
        role: 'assistant',
        text: `▸ tool: ${String(event.payload.tool ?? 'unknown')}`,
      });
    }
    if (event.type === 'error') {
      out.push({ kind: 'message', role: 'assistant', text: `Error: ${String(event.payload.message ?? 'unknown')}` });
    }
    if (event.type === 'provider_request') {
      flushAssistant(out, assistantBuf);
      assistantBuf = '';
      const request = providerRequestFromPayload(event.payload);
      if (request) {
        requests.set(request.requestId, request);
        out.push(request);
      }
    }
    if (event.type === 'provider_request_resolved') {
      const requestId = payloadString(event.payload, 'requestId');
      const existing = requestId ? requests.get(requestId) : undefined;
      const decision = providerRequestDecision(event.payload);
      if (existing) {
        existing.status = 'resolved';
        existing.decision = decision;
      } else if (requestId) {
        out.push({
          kind: 'provider_request',
          requestId,
          provider: payloadString(event.payload, 'provider') ?? 'provider',
          method: payloadString(event.payload, 'method') ?? 'request',
          status: 'resolved',
          decision,
        });
      }
    }
  }

  if (assistantBuf) {
    out.push({ kind: 'message', role: 'assistant', text: assistantBuf, streaming: true });
  }

  return out;
}

function flushAssistant(out: TranscriptItem[], text: string) {
  if (text.trim()) out.push({ kind: 'message', role: 'assistant', text });
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

export function Transcript({
  events,
  streaming,
  respondingRequestId,
  onRespondProviderRequest,
}: TranscriptProps) {
  const messages = useMemo(() => buildMessages(events), [events]);
  const isWriting = streaming && messages.some((m) => m.kind === 'message' && m.streaming);

  const indicatorLabel = isWriting ? 'Nuncio is writing…' : 'Nuncio is working…';

  // Place the working indicator right after the last user message (so it sits
  // BELOW the user's prompt, before any assistant deltas). When there is no
  // user message, fall back to the end of the transcript.
  const indicatorIndex = useMemo(() => {
    if (!streaming) return -1;
    let lastUser = -1;
    for (let i = 0; i < messages.length; i++) {
      const item = messages[i];
      if (item.kind === 'message' && item.role === 'user') lastUser = i;
    }
    return lastUser === -1 ? messages.length : lastUser + 1;
  }, [messages, streaming]);

  return (
    <div className="flex flex-col gap-5 py-4">
      {messages.map((msg, i) => (
        <Fragment key={i}>
          {i === indicatorIndex && <WorkingIndicator label={indicatorLabel} />}
          {msg.kind === 'provider_request' ? (
            <ProviderRequestCard
              request={msg}
              responding={respondingRequestId === msg.requestId}
              onRespond={onRespondProviderRequest}
            />
          ) : (
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
          )}
        </Fragment>
      ))}
      {streaming && indicatorIndex >= messages.length && (
        <WorkingIndicator label={indicatorLabel} />
      )}
    </div>
  );
}

function providerRequestFromPayload(payload: Record<string, unknown>): ProviderRequestView | null {
  const requestId = payloadString(payload, 'requestId');
  if (!requestId) return null;
  return {
    kind: 'provider_request',
    requestId,
    provider: payloadString(payload, 'provider') ?? 'provider',
    method: payloadString(payload, 'method') ?? 'request',
    params: payload.params,
    status: payloadString(payload, 'status') === 'resolved' ? 'resolved' : 'pending',
    decision: providerRequestDecision(payload),
  };
}

function providerRequestDecision(payload: Record<string, unknown>): ProviderRequestDecision | undefined {
  const decision = payloadString(payload, 'decision');
  return decision === 'approve' || decision === 'deny' ? decision : undefined;
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}
