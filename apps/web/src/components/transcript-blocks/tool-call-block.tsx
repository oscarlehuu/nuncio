import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { ToolSummary } from '@/lib/tool-summary';

function formatPayload(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractBashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const data = input as Record<string, unknown>;
  if (typeof data.cmd === 'string') return data.cmd;
  if (typeof data.command === 'string') return data.command;
  return undefined;
}

function truncate(subject: string, max = 80): string {
  if (subject.length <= max) return subject;
  return subject.slice(0, max - 1) + '…';
}

export interface ToolCallBlockProps {
  callId: string;
  tool: string;
  status: 'running' | 'done' | 'error';
  input?: unknown;
  output?: unknown;
  summary: ToolSummary;
}

export function ToolCallBlock({
  tool,
  status,
  input,
  output,
  summary,
}: ToolCallBlockProps) {
  const [open, setOpen] = useState(false);
  const hasDetails = input !== undefined || output !== undefined;
  const bashCmd = extractBashCommand(input);

  const statusLabel = status === 'running' ? 'Running…' : status === 'error' ? 'Failed' : null;

  const row = (
    <>
      <span className="text-[12.5px] shrink-0">
        {summary.verb}
      </span>
      {summary.subject && (
        <code className="text-[12px] font-mono text-muted-foreground/90 bg-muted/25 px-1 py-0.5 rounded max-w-[55%] truncate">
          {truncate(summary.subject)}
        </code>
      )}
      {summary.context && (
        <span className="text-[12px] text-muted-foreground/70 font-mono truncate">
          {summary.context}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5 shrink-0">
        {status === 'running' && (
          <span className="inline-block size-1.5 rounded-full bg-primary animate-pulse" aria-hidden />
        )}
        {statusLabel && (
          <span
            className={cn(
              'text-[11px]',
              status === 'error' && 'text-destructive',
              status === 'running' && 'text-muted-foreground',
            )}
            aria-live={status === 'running' ? 'polite' : undefined}
          >
            {statusLabel}
          </span>
        )}
        {hasDetails && (
          <ChevronDown
            className={cn(
              'size-3 text-muted-foreground/50 transition-transform group-hover:text-muted-foreground',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        )}
      </span>
    </>
  );

  if (!hasDetails) {
    return (
      <div
        className="flex items-center gap-1.5 px-1 py-0.5 min-h-[20px] text-left text-muted-foreground"
        data-testid="tool-row"
        data-tool={tool}
      >
        {row}
      </div>
    );
  }

  return (
    <div data-testid="tool-row" data-tool={tool}>
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 px-1 py-0.5 min-h-[20px] text-left text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {row}
      </button>
      {open && (
        <div className="pl-3 pr-1 py-1">
          <div className="rounded bg-muted/20 border border-border/30 overflow-hidden max-h-[40vh] overflow-y-auto">
            {bashCmd && (
              <pre className="px-2.5 py-1.5 text-[11.5px] font-mono text-foreground/80 border-b border-border/30 whitespace-pre-wrap break-all">
                <span className="text-muted-foreground">{'$ '}</span>
                <span>{bashCmd}</span>
              </pre>
            )}
            {!bashCmd && input !== undefined && (
              <pre className="px-2.5 py-1.5 text-[11.5px] font-mono text-muted-foreground whitespace-pre-wrap break-all">
                {formatPayload(input)}
              </pre>
            )}
            {output !== undefined && (
              <pre className="px-2.5 py-1.5 text-[11.5px] font-mono text-foreground/80 whitespace-pre-wrap break-all">
                {formatPayload(output)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

