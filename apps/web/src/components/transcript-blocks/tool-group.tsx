import { ChevronDown, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { summarizeToolGroup, type ToolSummary } from '@/lib/tool-summary';
import { ToolCallBlock } from './tool-call-block';
import { ToolGlyph } from './tool-glyph';

export interface ToolGroupTool {
  callId: string;
  tool: string;
  status: 'running' | 'done' | 'error';
  input?: unknown;
  output?: unknown;
  summary: ToolSummary;
}

interface ToolGroupProps {
  tools: ToolGroupTool[];
}

export function ToolGroup({ tools }: ToolGroupProps) {
  const hasRunning = tools.some((t) => t.status === 'running');
  const hasError = tools.some((t) => t.status === 'error');
  const [open, setOpen] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const effectiveOpen = userToggled ? open : hasRunning;

  const summaryText = useMemo(() => summarizeToolGroup(tools), [tools]);

  if (tools.length === 0) return null;
  if (tools.length === 1) {
    const t = tools[0];
    return (
      <ToolCallBlock
        callId={t.callId}
        tool={t.tool}
        status={t.status}
        summary={t.summary}
        {...(t.input !== undefined ? { input: t.input } : {})}
        {...(t.output !== undefined ? { output: t.output } : {})}
      />
    );
  }

  const handleClick = () => {
    setUserToggled(true);
    setOpen((v) => !v);
  };

  return (
    <div className="rounded-md">
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 min-h-[22px] text-left text-muted-foreground transition-colors hover:bg-muted/40"
        aria-expanded={effectiveOpen}
        onClick={handleClick}
        data-testid="tool-group-summary"
      >
        <ToolGlyph verb={tools[0].summary.verb} status={hasError ? 'error' : undefined} />
        <span className="text-ui text-foreground/80">{summaryText}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {hasRunning && (
            <Loader2 className="size-3 animate-spin text-muted-foreground/70" aria-hidden />
          )}
          <ChevronDown
            className={cn(
              'size-3 text-muted-foreground/50 transition-transform group-hover:text-muted-foreground',
              effectiveOpen && 'rotate-180',
            )}
            aria-hidden
          />
        </span>
      </button>
      {effectiveOpen && (
        <div className="ml-[13px] mt-0.5 flex flex-col border-l border-border/40 pl-2 pr-0.5 pb-1">
          {tools.map((t) => (
            <ToolCallBlock
              key={t.callId}
              callId={t.callId}
              tool={t.tool}
              status={t.status}
              summary={t.summary}
              {...(t.input !== undefined ? { input: t.input } : {})}
              {...(t.output !== undefined ? { output: t.output } : {})}
            />
          ))}
        </div>
      )}
    </div>
  );
}
