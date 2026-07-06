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
 * Maps a tool-summary verb to a glyph + a desaturated category tint. Verb
 * strings are the stable public taxonomy from @nuncio/core `summarizeToolCall`,
 * so keying on them keeps this in lockstep with the summary text.
 *
 * Tint follows the transcript's three intents (mirrors diff-view's status hues):
 *   inspect (read / search / fetch) → info      — pulling context in
 *   mutate  (edit / write)          → success   — changing the workspace
 *   execute (run / generic)         → neutral   — everything else, stays calm
 */
const GLYPHS: Record<string, { Icon: LucideIcon; tone: string }> = {
  Read: { Icon: FileText, tone: 'text-info' },
  Listed: { Icon: List, tone: 'text-info' },
  Found: { Icon: Locate, tone: 'text-info' },
  Grepped: { Icon: Search, tone: 'text-info' },
  'Searched files': { Icon: FileSearch, tone: 'text-info' },
  'Searched the web': { Icon: Globe, tone: 'text-info' },
  Fetched: { Icon: Download, tone: 'text-info' },
  Edited: { Icon: PencilLine, tone: 'text-success' },
  Wrote: { Icon: FilePlus2, tone: 'text-success' },
  Ran: { Icon: Terminal, tone: 'text-muted-foreground' },
  Used: { Icon: Wrench, tone: 'text-muted-foreground' },
};

const FALLBACK = { Icon: Wrench, tone: 'text-muted-foreground' } as const;

function glyphFor(verb: string): { Icon: LucideIcon; tone: string } {
  return GLYPHS[verb] ?? FALLBACK;
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
  const { Icon, tone } = glyphFor(verb);
  return (
    <Icon
      className={cn('size-3.5 shrink-0', status === 'error' ? 'text-destructive' : tone, className)}
      aria-hidden
    />
  );
}
