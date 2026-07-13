import { ChevronDown, ChevronRight, Lock, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import type { DiffFile, DiffHunk } from '../lib/api';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { DiffView } from './diff-view';
import { SessionScmFileBlame } from './session-scm-file-blame';
import { collapsedLabel, type ComposerKey } from './session-changes-panel-format';
import { FileSummary } from './session-changes-panel-utils';

interface SessionChangeFileRowProps {
  file: DiffFile;
  isOpen: boolean;
  composerKey: ComposerKey | null;
  comment: string;
  sending: boolean;
  sentKey: ComposerKey | null;
  sessionId?: string;
  showBlame?: boolean;
  onToggle: (file: DiffFile) => void;
  onOpenComposer: (key: ComposerKey) => void;
  onCommentChange: (comment: string) => void;
  onSubmitComment: (file: DiffFile, hunk: DiffHunk, key: ComposerKey) => void;
}

export function SessionChangeFileRow({
  file,
  isOpen,
  composerKey,
  comment,
  sending,
  sentKey,
  sessionId,
  showBlame = false,
  onToggle,
  onOpenComposer,
  onCommentChange,
  onSubmitComment,
}: SessionChangeFileRowProps) {
  const [blameOpen, setBlameOpen] = useState(false);
  const expandable = !file.collapsed && file.hunks.length > 0;
  return (
    <li className="border-b border-border/40">
      {expandable ? (
        <button
          type="button"
          title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
          onClick={() => onToggle(file)}
          className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
        >
          {isOpen ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
          <FileSummary file={file} />
        </button>
      ) : (
        <div className="flex min-h-11 items-center gap-2 px-3 py-2">
          <Lock className="size-3.5 shrink-0 text-muted-foreground" />
          <FileSummary file={file} />
          <span className="shrink-0 text-xs text-muted-foreground">{collapsedLabel(file)}</span>
        </div>
      )}
      {isOpen && (
        <div className="px-3 pb-3">
          <DiffView
            hunks={file.hunks}
            className="mt-1"
            renderHunkAction={(_hunk, index) => {
              const key: ComposerKey = `${file.path}:${index}`;
              return (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-10 gap-1.5 px-3 text-xs"
                  onClick={() => onOpenComposer(key)}
                >
                  <MessageSquare className="size-3.5" />
                  Comment on hunk
                </Button>
              );
            }}
            renderHunkFooter={(hunk, index) => {
              const key: ComposerKey = `${file.path}:${index}`;
              if (composerKey !== key) {
                return sentKey === key ? (
                  <div className="border-t border-border/40 px-2 py-2 text-xs text-success">Sent to agent</div>
                ) : null;
              }
              return (
                <div className="flex flex-col gap-2 border-t border-border/40 bg-card/60 p-2">
                  <Textarea
                    value={comment}
                    onChange={(event) => onCommentChange(event.target.value)}
                    placeholder="Tell the agent what to change in this hunk…"
                    rows={3}
                    className="resize-none text-sm"
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      className="h-10 px-4"
                      onClick={() => onSubmitComment(file, hunk, key)}
                      disabled={!comment.trim() || sending}
                    >
                      {sending ? 'Sending…' : 'Send'}
                    </Button>
                  </div>
                </div>
              );
            }}
          />
          {showBlame && sessionId && (
            <SessionScmFileBlame
              sessionId={sessionId}
              path={file.path}
              open={blameOpen}
              onToggle={() => setBlameOpen((current) => !current)}
            />
          )}
        </div>
      )}
    </li>
  );
}
