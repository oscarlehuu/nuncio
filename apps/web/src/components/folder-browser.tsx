import { useCallback, useEffect, useState } from 'react';
import { ArrowUp, Folder, GitBranch, Loader2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { fetchDirectories, type DirListing } from '../lib/fs-api';

interface FolderBrowserProps {
  open: boolean;
  /** Initial path to browse from. Omit to start at the user's home dir. */
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

/**
 * Server-side folder browser modal. Lets the user navigate the host machine's
 * directories and pick an absolute path — necessary because browsers cannot
 * expose host filesystem paths. Works on every client including the iPhone
 * PWA, since browsing happens via `GET /api/fs/dirs` on the server.
 */
export function FolderBrowser({ open, initialPath, onSelect, onCancel }: FolderBrowserProps) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [currentPath, setCurrentPath] = useState<string | undefined>(initialPath);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string | undefined) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDirectories(path);
      setListing(result);
      setCurrentPath(result.current);
    } catch {
      setError('Failed to load directories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load(initialPath);
    // Only re-fetch when the dialog opens; internal navigation calls load() directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const navigate = (path: string) => void load(path);
  const retry = () => void load(currentPath);
  const handleSelect = () => {
    if (listing) onSelect(listing.current);
  };
  const parent = listing?.parent ?? null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-[480px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Browse folders</DialogTitle>
          <DialogDescription>
            Navigate the host machine and select a project folder. Git repos are marked.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 px-1">
          {parent !== null && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(parent)}
              aria-label="Parent directory"
              disabled={loading}
              className="shrink-0"
            >
              <ArrowUp className="size-3.5" />
            </Button>
          )}
          <div className="text-[12.5px] font-mono text-muted-foreground truncate min-w-0 flex-1" aria-label="Current path">
            {listing?.current ?? '—'}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-[200px] max-h-[50vh] rounded-md border border-border">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading…</span>
            </div>
          )}
          {!loading && error && (
            <div className="flex flex-col items-center justify-center gap-3 py-10 text-muted-foreground text-sm">
              <span>{error}</span>
              <Button size="sm" variant="outline" onClick={retry}>
                <RotateCw className="size-3.5" />
                <span>Retry</span>
              </Button>
            </div>
          )}
          {!loading && !error && listing && listing.entries.length === 0 && (
            <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
              No subdirectories
            </div>
          )}
          {!loading && !error && listing && listing.entries.length > 0 && (
            <ul className="py-1">
              {listing.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => navigate(entry.path)}
                    className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-accent/60 transition-colors"
                  >
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                    <span className="text-[13px] truncate flex-1">{entry.name}</span>
                    {entry.isGit && (
                      <Badge variant="secondary" className="text-[10px] font-mono px-1.5 py-0 h-[18px] gap-1">
                        <GitBranch className="size-2.5" />
                        git
                      </Badge>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSelect} disabled={!listing || loading}>
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
