import { useCallback, useEffect, useState } from 'react';
import { fetchGitStatus, fetchGitDiff, commitSession, pushSession } from '../lib/api';
import type { GitStatusDto, GitDiffDto, GitFileChange } from '../lib/api';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GitBranch } from 'lucide-react';

interface ReviewChangesProps {
  sessionId: string;
  defaultMessage?: string;
}

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return { dir: '', name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

function statusInfo(file: GitFileChange): { code: string; label: string; className: string } {
  const code = file.index.trim() || file.workTree.trim() || '?';
  switch (code) {
    case 'M':
      return { code, label: 'Modified', className: 'text-amber-500' };
    case 'A':
      return { code, label: 'Added', className: 'text-success' };
    case '?':
      return { code: 'U', label: 'Untracked', className: 'text-success' };
    case 'D':
      return { code, label: 'Deleted', className: 'text-destructive' };
    case 'R':
    case 'C':
      return { code, label: 'Renamed', className: 'text-info' };
    default:
      return { code, label: code, className: 'text-muted-foreground' };
  }
}

export function ReviewChanges({ sessionId, defaultMessage = '' }: ReviewChangesProps) {
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [diffsByPath, setDiffsByPath] = useState<Record<string, GitDiffDto>>({});
  const [loadingDiffPaths, setLoadingDiffPaths] = useState<Set<string>>(() => new Set());
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [message, setMessage] = useState(defaultMessage);
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(true);

  const loadStatus = useCallback(async () => {
    try {
      setLoading(true);
      const statusData = await fetchGitStatus(sessionId);
      setStatus(statusData);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load git changes');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleToggleFile = (path: string) => {
    if (expandedPath === path) {
      setExpandedPath(null);
      return;
    }

    setExpandedPath(path);
    if (diffsByPath[path] || loadingDiffPaths.has(path)) return;

    setLoadingDiffPaths((current) => {
      const next = new Set(current);
      next.add(path);
      return next;
    });

    void fetchGitDiff(sessionId, { path })
      .then((diff) => {
        setDiffsByPath((current) => ({ ...current, [path]: diff }));
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : 'Failed to load file diff');
      })
      .finally(() => {
        setLoadingDiffPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      });
  };

  const handleCommit = async () => {
    if (!message.trim() || committing) return;
    try {
      setCommitting(true);
      await commitSession(sessionId, message, true);
      toast.success('Changes committed successfully');
      setMessage('');
      setExpandedPath(null);
      setDiffsByPath({});
      await loadStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to commit changes');
    } finally {
      setCommitting(false);
    }
  };

  const handlePush = async () => {
    if (pushing) return;
    try {
      setPushing(true);
      await pushSession(sessionId, { force: false });
      toast.success('Changes pushed successfully');
      await loadStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to push changes');
    } finally {
      setPushing(false);
    }
  };

  if (loading && !status) {
    return <div className="px-3 py-3 text-sm text-muted-foreground">Loading git status…</div>;
  }

  const branchName = status?.branch || '';
  const files = status?.files || [];
  const isClean = status?.clean ?? true;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const totalInsertions = files.reduce((sum, file) => sum + (file.insertions ?? 0), 0);
  const totalDeletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  return (
    <div className="flex flex-col text-card-foreground">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-sm font-mono truncate">{branchName || 'detached'}</span>
          {(ahead > 0 || behind > 0) && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
              {ahead > 0 && (
                <span className="flex items-center gap-0.5">
                  <ArrowUp className="size-3" />
                  {ahead}
                </span>
              )}
              {behind > 0 && (
                <span className="flex items-center gap-0.5">
                  <ArrowDown className="size-3" />
                  {behind}
                </span>
              )}
            </span>
          )}
        </div>
        <Button
          size="sm"
          onClick={handlePush}
          disabled={committing || pushing}
          className="shrink-0"
        >
          {pushing ? 'Pushing…' : 'Push'}
        </Button>
      </div>

      <div className="border-t border-border/50">
        <button
          type="button"
          onClick={() => setFilesExpanded((v) => !v)}
          className="w-full flex items-center gap-1 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {filesExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span>
            {files.length === 0
              ? 'No Uncommitted Changes'
              : `${files.length} Uncommitted Change${files.length === 1 ? '' : 's'}`}
          </span>
          {files.length > 0 && (
            <span className="ml-auto flex items-center gap-1 font-mono normal-case">
              {totalInsertions > 0 && <span className="text-success">+{totalInsertions}</span>}
              {totalDeletions > 0 && <span className="text-destructive">-{totalDeletions}</span>}
            </span>
          )}
        </button>

        {filesExpanded && files.length > 0 && (
          <ul className="flex flex-col">
            {files.map((file) => {
              const { dir, name } = splitPath(file.path);
              const info = statusInfo(file);
              const insertions = file.insertions ?? 0;
              const deletions = file.deletions ?? 0;
              const expanded = expandedPath === file.path;
              const diff = diffsByPath[file.path];
              const loadingDiff = loadingDiffPaths.has(file.path);
              return (
                <li key={file.path} className="flex flex-col">
                  <button
                    type="button"
                    title={file.path}
                    onClick={() => handleToggleFile(file.path)}
                    className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-muted/40"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-mono">
                      <span className="text-foreground">{name}</span>
                      {dir && <span className="ml-1 text-muted-foreground text-xs truncate">{dir}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
                      {insertions > 0 && <span className="text-success">+{insertions}</span>}
                      {deletions > 0 && <span className="text-destructive">-{deletions}</span>}
                      {info.code === 'U' ? (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-success">
                          New
                        </span>
                      ) : (
                        <span className={`${info.className}`} aria-label={info.label}>
                          {info.code}
                        </span>
                      )}
                    </span>
                  </button>
                  {expanded && (
                    <div className="px-3 pb-2">
                      {loadingDiff && !diff ? (
                        <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                          Loading diff…
                        </div>
                      ) : (
                        <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
                          {diff?.diff ?? ''}
                        </pre>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!isClean && (
        <div className="flex flex-col gap-2 border-t border-border/50 px-3 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Commit Message
          </div>
          <Textarea
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={committing || pushing}
            rows={2}
            className="text-sm resize-none"
          />
          <Button
            onClick={handleCommit}
            disabled={!message.trim() || isClean || committing || pushing}
            className="w-full"
          >
            {committing ? 'Committing…' : 'Commit'}
          </Button>
        </div>
      )}
    </div>
  );
}
