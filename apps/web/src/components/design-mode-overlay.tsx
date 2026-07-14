import { useEffect, useRef } from 'react';
import { CornerDownLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DesignModeComponent } from '@/lib/design-mode-serialize';

interface DesignModeOverlayProps {
  text: string;
  caret: number;
  components: DesignModeComponent[];
  sending?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onTextChange: (text: string, caret: number) => void;
  onSend: () => void;
  focusNonce: number;
  className?: string;
}

/** Cursor-style floating pill composer (lives in the React gap under BrowserView). */
export function DesignModeOverlay({
  text,
  caret,
  components,
  sending = false,
  disabled = false,
  disabledReason,
  onTextChange,
  onSend,
  focusNonce,
  className,
}: DesignModeOverlayProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el || el.disabled) return;
    el.focus();
    const next = Math.max(0, Math.min(caret, text.length));
    try {
      el.setSelectionRange(next, next);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus only on explicit bumps
  }, [focusNonce]);

  const canSend = !disabled && !sending && (text.trim().length > 0 || components.length > 0);
  const latest = components[components.length - 1];

  return (
    <div
      className={cn('flex w-full justify-center px-3 pb-3 pt-1', className)}
      data-testid="design-mode-overlay"
    >
      <div
        className={cn(
          'flex w-full max-w-[520px] items-center gap-2 rounded-full border border-border/80',
          'bg-card/95 px-3 py-2 shadow-lg backdrop-blur-md',
        )}
      >
        {latest ? (
          <span
            className="max-w-[120px] shrink-0 truncate rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary"
            title={latest.cssPath || latest.xpath || latest.label}
          >
            {latest.label}
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">Design</span>
        )}
        <input
          ref={inputRef}
          value={text}
          aria-label="Design Mode prompt"
          placeholder="Describe the change…"
          disabled={disabled || sending}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-sm outline-none',
            'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          )}
          onChange={(event) => {
            onTextChange(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          onSelect={(event) => {
            const target = event.currentTarget;
            onTextChange(target.value, target.selectionStart ?? target.value.length);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <Button
          size="icon-sm"
          className="shrink-0 rounded-full"
          aria-label="Send Design Mode steer"
          disabled={!canSend}
          onClick={onSend}
        >
          {sending ? <Loader2 className="size-3.5 animate-spin" /> : <CornerDownLeft className="size-3.5" />}
        </Button>
      </div>
      {disabled && disabledReason ? (
        <p className="sr-only">{disabledReason}</p>
      ) : null}
    </div>
  );
}
