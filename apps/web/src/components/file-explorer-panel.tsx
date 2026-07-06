import { useCallback, useEffect, useMemo, useState } from 'react';
import { File, Folder, FolderOpen, Pencil, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { deleteEntry, listEntries, makeDir, readFile, renameEntry, writeFile, type FileEntry, type FileReadResult } from '../lib/fs-api';
import { CodeBlock, MarkdownView } from './markdown-view';

interface FileExplorerPanelProps {
  root?: string;
  openPath?: string | null;
}

type EntryMap = Record<string, FileEntry[]>;

type TreeNodeProps = {
  entry: FileEntry;
  depth: number;
  entriesByPath: EntryMap;
  expanded: Set<string>;
  selectedPath?: string;
  onToggle: (entry: FileEntry) => void;
  onSelect: (entry: FileEntry) => void;
};

function parentPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function normalizeOpenPath(path: string | null | undefined): string {
  return (path ?? '').trim().replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function ancestorDirs(path: string): string[] {
  const dirs: string[] = [''];
  let parent = parentPath(path);
  const stack: string[] = [];
  while (parent) {
    stack.unshift(parent);
    parent = parentPath(parent);
  }
  return dirs.concat(stack);
}

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

function isMarkdown(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

const CODE_LANGUAGES: Record<string, string> = {
  json: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  html: 'HTML',
  css: 'CSS',
  js: 'JS',
  jsx: 'JSX',
  ts: 'TS',
  tsx: 'TSX',
  sh: 'SH',
  sql: 'SQL',
};

function extension(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx === -1 ? '' : path.slice(idx + 1).toLowerCase();
}

function isPreviewable(path: string): boolean {
  return isMarkdown(path) || extension(path) in CODE_LANGUAGES;
}

function renderPreview(path: string, draft: string) {
  if (isMarkdown(path)) {
    return <MarkdownView text={draft} className="rounded-md border border-border/40 bg-background/70 p-3" />;
  }
  const ext = extension(path);
  const language = CODE_LANGUAGES[ext];
  if (ext === 'json') {
    try {
      return <CodeBlock language={language} code={JSON.stringify(JSON.parse(draft), null, 2)} />;
    } catch (err) {
      return (
        <div>
          <CodeBlock language={language} code={draft} />
          <div className="text-xs text-destructive">Invalid JSON: {err instanceof Error ? err.message : String(err)}</div>
        </div>
      );
    }
  }
  return <CodeBlock language={language} code={draft} />;
}

function TreeNode({ entry, depth, entriesByPath, expanded, selectedPath, onToggle, onSelect }: TreeNodeProps) {
  const isDir = entry.kind === 'dir';
  const isOpen = expanded.has(entry.path);
  const children = entriesByPath[entry.path] ?? [];
  return (
    <div>
      <button
        type="button"
        onClick={() => (isDir ? onToggle(entry) : onSelect(entry))}
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted/60',
          selectedPath === entry.path && 'bg-muted text-foreground',
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {isDir ? (
          isOpen ? <FolderOpen className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />
        ) : (
          <File className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {isDir && isOpen && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              entriesByPath={entriesByPath}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileExplorerPanel({ root, openPath }: FileExplorerPanelProps) {
  const [entriesByPath, setEntriesByPath] = useState<EntryMap>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [file, setFile] = useState<FileReadResult | null>(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState('');
  const [preview, setPreview] = useState(false);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = file && 'content' in file && draft !== saved;
  const rootEntries = entriesByPath[''] ?? [];

  const loadDir = useCallback(async (path: string) => {
    if (!root) return;
    setLoadingPath(path);
    setError(null);
    try {
      const listing = await listEntries(root, path);
      setEntriesByPath((current) => ({ ...current, [path]: listing.entries }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingPath(null);
    }
  }, [root]);

  useEffect(() => {
    setEntriesByPath({});
    setExpanded(new Set());
    setSelected(null);
    setFile(null);
    setDraft('');
    setSaved('');
    setPreview(false);
    if (root) void loadDir('');
  }, [root, loadDir]);

  const handleToggle = useCallback((entry: FileEntry) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!entriesByPath[entry.path]) void loadDir(entry.path);
  }, [entriesByPath, loadDir]);

  const openEntry = useCallback(async (entry: FileEntry) => {
    if (!root || entry.kind !== 'file') return;
    setSelected(entry);
    setFile(null);
    setDraft('');
    setSaved('');
    setPreview(isMarkdown(entry.path));
    setLoadingPath(entry.path);
    setError(null);
    try {
      const result = await readFile(root, entry.path);
      setFile(result);
      if ('content' in result) {
        setDraft(result.content);
        setSaved(result.content);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingPath(null);
    }
  }, [root]);

  const handleSelect = useCallback((entry: FileEntry) => {
    void openEntry(entry);
  }, [openEntry]);

  useEffect(() => {
    const targetPath = normalizeOpenPath(openPath);
    if (!root || !targetPath) return;
    let cancelled = false;

    const openTarget = async () => {
      setLoadingPath(targetPath);
      setError(null);
      try {
        const parents = ancestorDirs(targetPath);
        const loaded: EntryMap = {};
        let target: FileEntry | null = null;
        for (const parent of parents) {
          const listing = await listEntries(root, parent);
          if (cancelled) return;
          loaded[parent] = listing.entries;
          if (parent === parentPath(targetPath)) {
            target = listing.entries.find((entry) => entry.path === targetPath) ?? null;
          }
        }

        setEntriesByPath((current) => ({ ...current, ...loaded }));
        setExpanded((current) => {
          const next = new Set(current);
          for (const parent of parents) {
            if (parent) next.add(parent);
          }
          if (target?.kind === 'dir') next.add(target.path);
          return next;
        });

        if (target?.kind === 'dir') {
          setSelected(target);
          setFile(null);
          setDraft('');
          setSaved('');
          setPreview(false);
          if (!loaded[target.path]) {
            const listing = await listEntries(root, target.path);
            if (cancelled) return;
            setEntriesByPath((current) => ({ ...current, [target!.path]: listing.entries }));
          }
          return;
        }

        await openEntry(target ?? { name: basename(targetPath), path: targetPath, kind: 'file' });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoadingPath(null);
      }
    };

    void openTarget();
    return () => {
      cancelled = true;
    };
  }, [openEntry, openPath, root]);

  const refreshSelectedParent = useCallback(async () => {
    await loadDir(selected ? parentPath(selected.path) : '');
  }, [loadDir, selected]);

  const handleSave = async () => {
    if (!root || !selected || !('content' in (file ?? {})) || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await writeFile(root, selected.path, draft);
      setSaved(draft);
      await refreshSelectedParent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleNewFile = async () => {
    if (!root) return;
    const base = selected?.kind === 'dir' ? selected.path : selected ? parentPath(selected.path) : '';
    const name = window.prompt('New file name');
    if (!name) return;
    const path = joinPath(base, name.trim());
    if (!path) return;
    setError(null);
    try {
      await writeFile(root, path, '');
      await loadDir(base);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleNewFolder = async () => {
    if (!root) return;
    const base = selected?.kind === 'dir' ? selected.path : selected ? parentPath(selected.path) : '';
    const name = window.prompt('New folder name');
    if (!name) return;
    const path = joinPath(base, name.trim());
    if (!path) return;
    setError(null);
    try {
      await makeDir(root, path);
      await loadDir(base);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRename = async () => {
    if (!root || !selected) return;
    const nextName = window.prompt('Rename to', selected.name);
    if (!nextName || nextName === selected.name) return;
    const to = joinPath(parentPath(selected.path), nextName.trim());
    setError(null);
    try {
      await renameEntry(root, selected.path, to);
      setSelected(null);
      setFile(null);
      await loadDir(parentPath(selected.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async () => {
    if (!root || !selected) return;
    if (!window.confirm(`Delete ${selected.path}?`)) return;
    setError(null);
    try {
      await deleteEntry(root, selected.path);
      const parent = parentPath(selected.path);
      setSelected(null);
      setFile(null);
      setDraft('');
      setSaved('');
      await loadDir(parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const viewer = useMemo(() => {
    if (!selected) return <div className="text-sm text-muted-foreground">Select a file to view or edit.</div>;
    if (loadingPath === selected.path && !file) return <div className="text-sm text-muted-foreground">Loading…</div>;
    if (!file) return null;
    if ('binary' in file && file.binary) return <div className="text-sm text-muted-foreground">Binary file</div>;
    if ('truncated' in file && file.truncated) return <div className="text-sm text-muted-foreground">File too large to preview</div>;
    if (!('content' in file)) return null;
    if (preview && isPreviewable(selected.path)) {
      return renderPreview(selected.path, draft);
    }
    return (
      <Textarea
        aria-label="File editor"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        className="min-h-[360px] flex-1 resize-none font-mono text-xs"
      />
    );
  }, [draft, file, loadingPath, preview, selected]);

  if (!root) {
    return <div className="p-3 text-sm text-muted-foreground">No working directory for this session.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-explorer-panel-real">
      <div className="flex items-center gap-1 border-b border-border/60 px-2 py-2">
        <Button variant="ghost" size="sm" onClick={handleNewFile} className="h-7 gap-1 px-2 text-xs">
          <Plus className="size-3" /> File
        </Button>
        <Button variant="ghost" size="sm" onClick={handleNewFolder} className="h-7 gap-1 px-2 text-xs">
          <Folder className="size-3" /> Folder
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => void loadDir('')} aria-label="Refresh files">
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {error && <div className="border-b border-destructive/30 px-3 py-2 text-xs text-destructive">{error}</div>}
      <div className="grid min-h-0 flex-1 grid-cols-[42%_58%]">
        <div className="min-h-0 overflow-y-auto border-r border-border/60 p-1">
          {loadingPath === '' && rootEntries.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>
          ) : rootEntries.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">No files</div>
          ) : (
            rootEntries.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                entriesByPath={entriesByPath}
                expanded={expanded}
                selectedPath={selected?.path}
                onToggle={handleToggle}
                onSelect={handleSelect}
              />
            ))
          )}
        </div>
        <div className="min-h-0 overflow-y-auto p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0 truncate text-xs font-medium">{selected?.path ?? root}</div>
            <div className="flex shrink-0 items-center gap-1">
              {selected && isPreviewable(selected.path) && file && 'content' in file && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPreview((value) => !value)}>
                  {preview ? 'Edit' : 'Preview'}
                </Button>
              )}
              {selected && (
                <>
                  <Button variant="ghost" size="icon-sm" aria-label="Rename" onClick={handleRename}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Delete" onClick={handleDelete}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}
              <Button size="sm" className="h-7 gap-1 px-2 text-xs" onClick={handleSave} disabled={!dirty || saving}>
                <Save className="size-3" /> Save
              </Button>
            </div>
          </div>
          {viewer}
        </div>
      </div>
    </div>
  );
}
