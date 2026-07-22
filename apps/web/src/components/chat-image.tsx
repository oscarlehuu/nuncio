import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * An image inside the transcript — user-attached or emitted by the agent as
 * markdown. Renders a bounded, rounded thumbnail; clicking opens a lightbox so
 * the full resolution is one tap away without leaving the chat.
 */
export function ChatImage({
  src,
  alt,
  className,
}: {
  src?: string;
  alt?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  const caption = alt?.trim() ? alt.trim() : 'image';
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View ${caption}`}
        className={cn(
          'block max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/20 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        <img
          src={src}
          alt={alt ?? ''}
          loading="lazy"
          className="max-h-64 w-auto max-w-full object-contain"
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-auto max-w-[92vw] bg-transparent p-2 ring-0 shadow-none sm:max-w-[80vw]">
          <DialogTitle className="sr-only">{caption}</DialogTitle>
          <img
            src={src}
            alt={alt ?? ''}
            className="mx-auto max-h-[85vh] w-auto max-w-full rounded-lg object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
