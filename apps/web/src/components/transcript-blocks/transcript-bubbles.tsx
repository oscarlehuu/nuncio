import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MarkdownView, type MarkdownLinkClickHandler } from '../markdown-view';
import { useReducedMotion } from '../appearance-provider';
import { useRevealedText } from '@/lib/use-revealed-text';
import { cn } from '@/lib/utils';

export function AssistantBubble({
  text,
  streaming,
  onLinkClick,
}: {
  text: string;
  streaming?: boolean;
  onLinkClick?: MarkdownLinkClickHandler;
}) {
  // Only the actively streaming bubble pays for reveal state and the
  // motion-preference listener; the (many) settled bubbles render plain.
  if (streaming) {
    return <StreamingAssistantBubble text={text} onLinkClick={onLinkClick} />;
  }
  return <MarkdownView text={text} onLinkClick={onLinkClick} />;
}

function StreamingAssistantBubble({
  text,
  onLinkClick,
}: {
  text: string;
  onLinkClick?: MarkdownLinkClickHandler;
}) {
  // Smoothly reveal streamed text (see use-revealed-text); reduce-motion
  // passes through in whole chunks exactly like before.
  const reduceMotion = useReducedMotion();
  const revealed = useRevealedText(text, true, reduceMotion);
  return (
    <>
      <MarkdownView text={revealed} streaming onLinkClick={onLinkClick} />
      <span className="inline-block w-2 h-4 ml-0.5 bg-primary animate-pulse align-middle" />
    </>
  );
}

/** Collapse threshold for user messages — longer messages show a preview + "Show more". */
const USER_MSG_COLLAPSE_THRESHOLD = 600;
const USER_MSG_PREVIEW = 400;

export function UserBubble({
  text,
  onLinkClick,
}: {
  text: string;
  onLinkClick?: MarkdownLinkClickHandler;
}) {
  const isLong = text.length > USER_MSG_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);

  if (!isLong) {
    return (
      <div className="text-foreground/90">
        <MarkdownView text={text} onLinkClick={onLinkClick} />
      </div>
    );
  }

  const preview = text.slice(0, USER_MSG_PREVIEW);

  return (
    <div className="text-foreground/90" data-testid="user-bubble-collapsible">
      <MarkdownView text={expanded ? text : preview} onLinkClick={onLinkClick} />
      {!expanded && (
        <div className="mt-1 text-muted-foreground/60 text-ui">
          … {text.length - USER_MSG_PREVIEW} more chars
        </div>
      )}
      <button
        type="button"
        className="group mt-1.5 flex items-center gap-1 text-ui text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-testid="user-bubble-toggle"
      >
        <span>{expanded ? 'Show less' : 'Show more'}</span>
        <ChevronDown
          className={cn('size-3 transition-transform', expanded && 'rotate-180')}
          aria-hidden
        />
      </button>
    </div>
  );
}

export function ErrorBlock({ message }: { message: string }) {
  return <span className="text-destructive">Error: {message}</span>;
}
