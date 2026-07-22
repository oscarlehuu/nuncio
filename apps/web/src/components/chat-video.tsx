import { cn } from '@/lib/utils';

/**
 * An inline video player for markdown / forge comment links that point at
 * mp4/webm/mov assets. Keeps the same bounded card treatment as ChatImage.
 */
export function ChatVideo({
  src,
  title,
  className,
}: {
  src?: string;
  title?: string;
  className?: string;
}) {
  if (!src) return null;
  const label = title?.trim() ? title.trim() : 'video';
  return (
    <div
      className={cn(
        'my-2 max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/20',
        className,
      )}
    >
      <video
        src={src}
        controls
        preload="metadata"
        playsInline
        aria-label={label}
        className="max-h-80 w-full max-w-full bg-black object-contain"
      />
    </div>
  );
}
