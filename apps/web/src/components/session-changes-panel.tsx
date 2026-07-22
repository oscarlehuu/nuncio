import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  commitSession,
  countDebugSentinelLines,
  fetchGitBranchSync,
  fetchGitHistory,
  fetchGitStash,
  fetchSessionDiff,
  generateCommitMessage,
  openPullRequest,
  postDiffComment,
  pushSession,
  type DiffFile,
  type DiffHunk,
  type GitBranchSyncDto,
  type GitHistoryDto,
  type GitStashEntryDto,
  type SessionDiff,
  type SessionStatus,
} from '../lib/api';
import { AlertTriangle, ChevronDown, Loader2, Sparkles } from 'lucide-react';
import { SessionChangeFileRow } from './session-change-file-row';
import { SessionScmBranchStrip } from './session-scm-branch-strip';
import { SessionScmCommitList } from './session-scm-commit-list';
import { SessionScmConflicts } from './session-scm-conflicts';
import { SessionScmHistory } from './session-scm-history';
import { SessionScmIssues } from './session-scm-issues';
import { SessionScmStash } from './session-scm-stash';
import { hunkRange, hunkText, type ComposerKey } from './session-changes-panel-format';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Textarea } from './ui/textarea';

interface SessionChangesPanelProps {
  sessionId: string;
  sessionStatus: SessionStatus;
  repoPath?: string;
  branch?: string | null;
}

const CLEAN_SYNC: GitBranchSyncDto = {
  branch: 'main',
  base: null,
  ahead: 0,
  behind: 0,
  outgoing: [],
  incoming: [],
  conflicts: [],
  clean: true,
};

export function SessionChangesPanel({
  sessionId,
  sessionStatus,
  repoPath,
  branch,
}: SessionChangesPanelProps) {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [sync, setSync] = useState<GitBranchSyncDto | null>(null);
  const [stash, setStash] = useState<GitStashEntryDto[]>([]);
  const [history, setHistory] = useState<GitHistoryDto | null>(null);
  const [historyBranch, setHistoryBranch] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [composerKey, setComposerKey] = useState<ComposerKey | null>(null);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [sentKey, setSentKey] = useState<ComposerKey | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [generating, setGenerating] = useState(false);

  const generateMessage = async () => {
    if (generating || committing) return;
    try {
      setGenerating(true);
      const result = await generateCommitMessage(sessionId);
      setCommitMessage(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate a commit message');
    } finally {
      setGenerating(false);
    }
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [nextDiff, nextSync, nextStash, nextHistory] = await Promise.all([
        fetchSessionDiff(sessionId),
        fetchGitBranchSync(sessionId).catch(() => null),
        fetchGitStash(sessionId).catch(() => [] as GitStashEntryDto[]),
        fetchGitHistory(sessionId, {
          limit: 15,
          ...(historyBranch ? { branch: historyBranch } : {}),
        }).catch(() => null),
      ]);
      setDiff(nextDiff);
      setSync(nextSync);
      setStash(nextStash);
      setHistory(nextHistory);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load changes');
    } finally {
      setLoading(false);
    }
  }, [sessionId, historyBranch]);

  useEffect(() => {
    void load();
  }, [load]);

  const onHistoryBranchChange = useCallback((next: string) => {
    setHistoryBranch((current) => (current === next ? current : next));
  }, []);

  const totals = useMemo(() => {
    const files = diff?.files ?? [];
    return files.reduce(
      (sum, file) => ({
        additions: sum.additions + file.additions,
        deletions: sum.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 },
    );
  }, [diff]);

  // D3 guard: a debug session's final diff must be free of `// nuncio-debug`
  // instrumentation. Warn if the sweep left any behind.
  const sentinels = useMemo(() => countDebugSentinelLines(diff), [diff]);

  const toggle = (file: DiffFile) => {
    if (file.collapsed || file.hunks.length === 0) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(file.path)) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  };

  const submitComment = async (file: DiffFile, hunk: DiffHunk, key: ComposerKey) => {
    const trimmed = comment.trim();
    if (!trimmed || sending) return;
    const range = hunkRange(hunk);
    try {
      setSending(true);
      await postDiffComment(sessionId, {
        path: file.path,
        startLine: range.startLine,
        endLine: range.endLine,
        hunk: hunkText(hunk),
        comment: trimmed,
      });
      setComment('');
      setComposerKey(null);
      setSentKey(key);
      toast.success(
        sessionStatus === 'RUNNING'
          ? 'Sent to agent — queued for the running session'
          : 'Sent to agent',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send diff comment');
    } finally {
      setSending(false);
    }
  };

  // Stacked commit actions: commit, then optionally push and open a PR, with
  // one staged toast per chain. The chain stops at the first failing stage.
  const submitCommit = async (action: 'commit' | 'commit_push' | 'commit_push_pr' = 'commit') => {
    const message = commitMessage.trim();
    if (!message || committing) return;
    const toastId = action === 'commit' ? undefined : toast.loading('Committing…');
    try {
      setCommitting(true);
      const result = await commitSession(sessionId, message);
      const sha = result.sha ? result.sha.slice(0, 7) : '';
      if (action === 'commit') {
        toast.success(sha ? `Committed ${sha}` : 'Committed');
      } else {
        toast.loading('Pushing…', { id: toastId });
        await pushSession(sessionId);
        if (action === 'commit_push_pr') {
          toast.loading('Opening pull request…', { id: toastId });
          const pr = await openPullRequest(sessionId);
          toast.success(pr.number ? `Pull request #${pr.number} opened` : 'Pull request opened', {
            id: toastId,
          });
        } else {
          toast.success(sha ? `Committed ${sha} & pushed` : 'Committed & pushed', { id: toastId });
        }
      }
      setCommitMessage('');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Git action failed';
      if (toastId) toast.error(messageText, { id: toastId });
      else toast.error(messageText);
    } finally {
      setCommitting(false);
      // Reload even on a mid-chain failure: a commit that landed before a
      // failed push must be reflected (otherwise retrying re-commits nothing
      // and the panel keeps offering the wrong action).
      await load();
    }
  };

  if (loading && !diff && !sync) {
    return <div className="px-3 py-3 text-sm text-muted-foreground">Loading changes…</div>;
  }

  const files = diff?.files ?? [];
  const branchSync = sync ?? {
    ...CLEAN_SYNC,
    branch: branch?.trim() || 'HEAD',
  };
  const hasOutgoing = branchSync.outgoing.length > 0;
  const hasIncoming = branchSync.incoming.length > 0;
  const hasStash = stash.length > 0;
  const hasHistory = (history?.commits.length ?? 0) > 0;
  const hasFiles = files.length > 0;
  // Staged-only work leaves the unstaged diff empty but the tree dirty — the
  // commit box must still show (commit auto-stages, so it can commit the index).
  const showCommit = hasFiles || !branchSync.clean;
  const fullyEmpty =
    branchSync.clean &&
    !hasFiles &&
    !hasOutgoing &&
    !hasIncoming &&
    !hasStash &&
    !hasHistory &&
    branchSync.conflicts.length === 0;

  return (
    <div className="flex h-full flex-col text-card-foreground">
      <SessionScmBranchStrip
        sessionId={sessionId}
        sync={branchSync}
        repoPath={repoPath}
        branch={branch ?? branchSync.branch}
        onChanged={() => void load()}
        refreshing={loading}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SessionScmConflicts conflicts={branchSync.conflicts} />

        <SessionScmCommitList
          title={`${branchSync.outgoing.length} outgoing commit${branchSync.outgoing.length === 1 ? '' : 's'}`}
          direction="up"
          commits={branchSync.outgoing}
          base={branchSync.base}
          sessionId={sessionId}
        />

        <SessionScmCommitList
          title={`${branchSync.incoming.length} incoming commit${branchSync.incoming.length === 1 ? '' : 's'}`}
          direction="down"
          commits={branchSync.incoming}
          base={branchSync.base}
          sessionId={sessionId}
        />

        <SessionScmStash entries={stash} />

        {hasFiles && (
          <div className="border-b border-border/50">
            <div className="flex min-h-10 items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 text-sm font-medium">
                {files.length} changed file{files.length === 1 ? '' : 's'}
              </span>
              <span className="shrink-0 font-mono text-xs">
                {totals.additions > 0 && <span className="text-success">+{totals.additions}</span>}{' '}
                {totals.deletions > 0 && <span className="text-destructive">-{totals.deletions}</span>}
              </span>
            </div>
            {diff?.truncated && (
              <div className="border-t border-border/50 bg-warning/10 px-3 py-2 text-xs text-muted-foreground">
                Diff truncated. {diff.omittedFiles} file{diff.omittedFiles === 1 ? '' : 's'} omitted.
              </div>
            )}
            {sentinels.count > 0 && (
              <div
                data-testid="debug-sentinel-warning"
                className="flex items-start gap-2 border-t border-border/50 bg-warning/10 px-3 py-2 text-xs text-warning"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  {sentinels.count} debug instrumentation line{sentinels.count === 1 ? '' : 's'}{' '}
                  (<span className="font-mono">// nuncio-debug</span>) still in the diff across{' '}
                  {sentinels.files.length} file{sentinels.files.length === 1 ? '' : 's'}. Remove them
                  before finishing.
                </span>
              </div>
            )}
            <ul>
              {files.map((file) => (
                <SessionChangeFileRow
                  key={file.path}
                  file={file}
                  isOpen={expanded.has(file.path)}
                  composerKey={composerKey}
                  comment={comment}
                  sending={sending}
                  sentKey={sentKey}
                  sessionId={sessionId}
                  showBlame
                  onToggle={toggle}
                  onOpenComposer={(key) => {
                    setComposerKey(key);
                    setComment('');
                  }}
                  onCommentChange={setComment}
                  onSubmitComment={(nextFile, hunk, key) => void submitComment(nextFile, hunk, key)}
                />
              ))}
            </ul>
          </div>
        )}

        {showCommit && (
          <div className="border-b border-border/50 px-3 py-3">
            <div className="mb-2 text-sm font-medium">Commit Message</div>
            <div className="relative mb-2">
              <Textarea
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Commit message"
                rows={2}
                className="resize-none pr-9 text-sm"
                disabled={committing}
              />
              <button
                type="button"
                aria-label="Generate commit message"
                title="Generate commit message"
                onClick={() => void generateMessage()}
                disabled={generating || committing}
                className="absolute right-1.5 top-1.5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {generating ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="size-3.5" aria-hidden />
                )}
              </button>
            </div>
            <div className="flex gap-px">
              <Button
                size="sm"
                className="flex-1 rounded-r-none"
                disabled={!commitMessage.trim() || committing}
                onClick={() => void submitCommit()}
              >
                {committing ? 'Committing…' : 'Commit'}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    className="rounded-l-none px-1.5"
                    aria-label="More commit actions"
                    disabled={!commitMessage.trim() || committing}
                  >
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => void submitCommit('commit_push')}
                    aria-label="Commit & push"
                  >
                    Commit & push
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void submitCommit('commit_push_pr')}
                    disabled={sessionStatus !== 'IDLE'}
                    aria-label="Commit, push & PR"
                  >
                    Commit, push & PR
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}

        {!showCommit && !fullyEmpty && (
          <div className="border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
            Working tree clean.
          </div>
        )}

        {fullyEmpty && (
          <div className="px-3 py-2 text-xs text-muted-foreground">No local changes.</div>
        )}

        <SessionScmHistory
          history={history}
          repoPath={repoPath}
          selectedBranch={historyBranch ?? history?.branch}
          onBranchChange={onHistoryBranchChange}
        />
        <SessionScmIssues repoPath={repoPath} />
      </div>
    </div>
  );
}
