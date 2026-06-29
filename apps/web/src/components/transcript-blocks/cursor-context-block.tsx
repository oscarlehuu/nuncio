import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FolderGit2,
  AlertTriangle,
  ListChecks,
  Terminal,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { CursorContextSection } from '@/lib/cursor-context';
import { MarkdownView } from '../markdown-view';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';

const SECTION_ICONS: Record<string, LucideIcon> = {
  pr_shared_context: FolderGit2,
  untrusted_ci_metadata: AlertTriangle,
  pr_check_annotations: ListChecks,
  pr_check_log_excerpt: Terminal,
  manually_attached_skills: Sparkles,
};

interface CursorContextBlockProps {
  summary: string;
  instruction: string;
  sections: CursorContextSection[];
}

function SectionView({ section }: { section: CursorContextSection }) {
  const [open, setOpen] = useState(false);
  const Icon = SECTION_ICONS[section.tag] ?? ClipboardList;
  const isLog = section.tag === 'pr_check_log_excerpt';

  return (
    <div className="rounded-md border border-border/30 overflow-hidden bg-muted/10">
      <button
        type="button"
        className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 transition-colors"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-[13px] font-medium text-foreground/80">{section.label}</span>
        <span className="ml-auto">
          {open ? (
            <ChevronDown className="size-3.5 text-muted-foreground transition-transform" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground transition-transform" aria-hidden />
          )}
        </span>
      </button>
      {open && (
        <pre
          className={`px-3 py-2.5 text-[11.5px] font-mono text-muted-foreground whitespace-pre-wrap break-all border-t border-border/30 max-h-[50vh] overflow-y-auto ${
            isLog ? 'leading-[1.4]' : 'leading-relaxed'
          }`}
        >
          {section.content}
        </pre>
      )}
    </div>
  );
}

export function CursorContextBlock({ summary, instruction, sections }: CursorContextBlockProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="group flex items-center gap-1.5 px-1 py-0.5 min-h-[20px] text-left text-foreground/70 hover:text-foreground transition-colors"
        onClick={() => setOpen(true)}
        data-testid="cursor-context-row"
      >
        <ClipboardList className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-[12.5px] font-medium">{summary}</span>
        <ChevronRight
          className="size-3 text-muted-foreground/50 group-hover:text-muted-foreground transition-transform"
          aria-hidden
        />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[80vh] flex flex-col" data-testid="cursor-context-sheet">
          <SheetHeader className="shrink-0 border-b border-border/30 pb-3">
            <div className="flex items-center gap-2">
              <ClipboardList className="size-4 text-muted-foreground" />
              <SheetTitle className="text-[15px]">{summary}</SheetTitle>
            </div>
            <SheetDescription className="text-[12px]">
              Cursor-generated context message
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {instruction && (
              <div className="text-[14px] leading-relaxed text-foreground rounded-md bg-muted/15 px-3 py-2.5 border border-border/20">
                <MarkdownView text={instruction} />
              </div>
            )}
            {sections.length > 0 && (
              <div className="space-y-1.5">
                {sections.map((section, i) => (
                  <SectionView key={`${section.tag}-${i}`} section={section} />
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
