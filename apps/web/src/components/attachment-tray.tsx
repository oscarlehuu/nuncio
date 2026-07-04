import { useRef } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { attachmentDataUrl, isImageAttachment } from '@/lib/api';
import type { PendingAttachment } from '@/lib/use-message-attachments';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Paperclip-style trigger that opens a native image picker. */
export function AttachButton({
  onFiles,
  disabled,
  label = 'Attach image',
  className,
}: {
  onFiles: (files: FileList | null) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn('shrink-0 text-muted-foreground', className)}
        aria-label={label}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <ImagePlus className="size-4" />
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          onFiles(e.target.files);
          // Reset so re-selecting the same file fires change again.
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Row of removable image thumbnails for images staged on the pending message. */
export function AttachmentTray({
  items,
  onRemove,
  className,
}: {
  items: PendingAttachment[];
  onRemove: (id: string) => void;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-2 px-3 pt-2.5', className)} data-testid="attachment-tray">
      {items.map((item) =>
        isImageAttachment(item.attachment) ? (
          <div key={item.id} className="group flex flex-col items-center gap-0.5">
            <div className="relative size-14 overflow-hidden rounded-lg border border-border/70 bg-muted/30 shadow-e1">
              <img
                src={attachmentDataUrl(item.attachment)}
                alt={item.label}
                className="size-full object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${item.label}`}
                onClick={() => onRemove(item.id)}
                className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-background/80 text-foreground/80 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
            <span className="text-[10px] leading-none text-muted-foreground">{item.label}</span>
          </div>
        ) : null,
      )}
    </div>
  );
}
