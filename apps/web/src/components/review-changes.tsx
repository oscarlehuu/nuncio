import { useCallback, useEffect, useState } from 'react';
import { fetchGitStatus, fetchGitDiff, commitSession, pushSession } from '../lib/api';
import type { GitStatusDto, GitDiffDto } from '../lib/api';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { toast } from 'sonner';

interface ReviewChangesProps {
  sessionId: string;
  defaultMessage?: string;
}

export function ReviewChanges({ sessionId, defaultMessage = '' }: ReviewChangesProps) {
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [diff, setDiff] = useState<GitDiffDto | null>(null);
  const [message, setMessage] = useState(defaultMessage);
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  const loadStatusAndDiff = useCallback(async () => {
    try {
      setLoading(true);
      const statusData = await fetchGitStatus(sessionId);
      setStatus(statusData);

      const diffData = await fetchGitDiff(sessionId);
      setDiff(diffData);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load git changes');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadStatusAndDiff();
  }, [loadStatusAndDiff]);

  const handleCommit = async () => {
    if (!message.trim() || committing) return;
    try {
      setCommitting(true);
      await commitSession(sessionId, message, true);
      toast.success('Changes committed successfully');
      setMessage('');
      await loadStatusAndDiff();
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
      await loadStatusAndDiff();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to push changes');
    } finally {
      setPushing(false);
    }
  };

  if (loading && !status) {
    return <div className="p-4 text-sm text-muted-foreground">Loading git status...</div>;
  }

  const branchName = status?.branch || '';
  const files = status?.files || [];
  const isClean = status?.clean ?? true;

  return (
    <div className="flex flex-col gap-4 p-4 border rounded-lg bg-card text-card-foreground">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Branch:</span>
          <span className="text-sm font-mono text-muted-foreground">{branchName}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase text-muted-foreground">Changed Files</span>
        {files.length === 0 ? (
          <span className="text-sm text-muted-foreground">No changed files</span>
        ) : (
          <ul className="text-sm font-mono flex flex-col gap-1">
            {files.map((file) => (
              <li key={file.path} className="flex items-center gap-2">
                <span className="text-xs bg-muted px-1.5 py-0.5 rounded border">
                  {file.index.trim() || file.workTree.trim() || '?'}
                </span>
                <span className="truncate">{file.path}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {diff?.diff && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setShowDiff((v) => !v)}
            className="self-start text-xs font-semibold uppercase text-muted-foreground hover:text-foreground"
          >
            {showDiff ? 'Hide diff' : 'Show diff'}
          </button>
          {showDiff && (
            <pre className="text-xs font-mono bg-muted p-3 rounded-lg overflow-x-auto max-h-60 border">
              {diff.diff}
            </pre>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Textarea
          placeholder="Commit message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={committing || pushing}
          rows={2}
          className="text-sm"
        />
        <div className="flex gap-2">
          <Button
            onClick={handleCommit}
            disabled={!message.trim() || isClean || committing || pushing}
            className="flex-1"
          >
            {committing ? 'Committing...' : 'Commit'}
          </Button>
          <Button
            onClick={handlePush}
            variant="outline"
            disabled={committing || pushing}
            className="flex-1"
          >
            {pushing ? 'Pushing...' : 'Push'}
          </Button>
        </div>
      </div>
    </div>
  );
}
