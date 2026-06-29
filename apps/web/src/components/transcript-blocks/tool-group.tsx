import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { summarizeToolGroup, type ToolSummary } from '@/lib/tool-summary';
import { ToolCallBlock } from './tool-call-block';

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
        className="group flex w-full items-center gap-1.5 px-1 py-0.5 min-h-[20px] text-left text-muted-foreground"
        aria-expanded={effectiveOpen}
        onClick={handleClick}
        data-testid="tool-group-summary"
      >
        {hasRunning && (
          <span className="inline-block size-1.5 rounded-full bg-primary animate-pulse" aria-hidden />
        )}
        <span className="text-[12.5px]">{summaryText}</span>
        <span className="ml-auto">
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
        <div className="pl-1 pr-0.5 pb-1 flex flex-col">
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
