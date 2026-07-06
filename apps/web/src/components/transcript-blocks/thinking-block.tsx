import { ChevronDown, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useThrottledStreamText } from '@/lib/use-throttled-stream-text';
import { cn } from '@/lib/utils';

export interface ThinkingBlockProps {
  text: string;
  streaming?: boolean;
}

export function ThinkingBlock({ text, streaming }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);
  const displayed = useThrottledStreamText(text, streaming ?? false);
  const durationS = Math.max(1, Math.round(text.length / 500));

  return (
    <div data-testid="thinking-row">
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 min-h-[22px] text-left text-muted-foreground transition-colors hover:bg-muted/40"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Sparkles
          className={cn(
            'size-3.5 shrink-0',
            streaming ? 'text-primary animate-pulse' : 'text-muted-foreground/70',
          )}
          aria-hidden
        />
        <span className="chat-text-xs text-foreground/80">
          {streaming ? 'Thinking…' : `Thought for ${durationS}s`}
        </span>
        <span className="ml-auto">
          <ChevronDown
            className={cn(
              'size-3 text-muted-foreground/50 transition-transform group-hover:text-muted-foreground',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 pt-0.5">
          <pre className="rounded-md bg-muted/30 border border-border/40 px-3 py-2 text-ui whitespace-pre-wrap break-all text-muted-foreground font-mono max-h-[40vh] overflow-y-auto">
            {displayed}
          </pre>
        </div>
      )}
    </div>
  );
}
