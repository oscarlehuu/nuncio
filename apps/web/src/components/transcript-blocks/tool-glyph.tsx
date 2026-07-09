import {
  Download,
  FileSearch,
  FileText,
  FilePlus2,
  Globe,
  List,
  Locate,
  PencilLine,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type ToolStatus = 'running' | 'done' | 'error';

/**
 * Maps a tool-summary verb to a glyph. Verb strings are the stable public
 * taxonomy from @nuncio/core `summarizeToolCall`, so keying on them keeps this
 * in lockstep with the summary text. The glyph shape alone carries the
 * category; every tool row stays muted gray — color is reserved for states
 * that need the founder (error red).
 */
const GLYPHS: Record<string, LucideIcon> = {
  Read: FileText,
  Listed: List,
  Found: Locate,
  Grepped: Search,
  'Searched files': FileSearch,
  'Searched the web': Globe,
  Fetched: Download,
  Edited: PencilLine,
  Wrote: FilePlus2,
  Ran: Terminal,
  Used: Wrench,
};

function glyphFor(verb: string): LucideIcon {
  return GLYPHS[verb] ?? Wrench;
}

/** Leading category glyph for a tool row/group. Error state overrides the tint. */
export function ToolGlyph({
  verb,
  status,
  className,
}: {
  verb: string;
  status?: ToolStatus;
  className?: string;
}) {
  const Icon = glyphFor(verb);
  return (
    <Icon
      className={cn(
        'size-3.5 shrink-0',
        status === 'error' ? 'text-destructive' : 'text-muted-foreground',
        className,
      )}
      aria-hidden
    />
  );
}
