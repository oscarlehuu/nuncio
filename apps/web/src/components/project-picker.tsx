import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, FolderGit2, FolderOpen } from 'lucide-react';
import { fetchProjects, projectDisplayName, type Project } from '../lib/projects';
import { loadProjectPreference, type RecentProject } from '../lib/project-preference';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { FolderBrowser } from './folder-browser';

interface ProjectPickerProps {
  value?: string;
  onChange: (path: string) => void;
}

export function ProjectPicker({ value, onChange }: ProjectPickerProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [browserOpen, setBrowserOpen] = useState(false);
  const [recents, setRecents] = useState<RecentProject[]>([]);

  useEffect(() => {
    void fetchProjects().then(setProjects);
  }, []);

  useEffect(() => {
    if (open) setRecents(loadProjectPreference().recentProjects);
  }, [open]);

  const recentPaths = useMemo(() => new Set(recents.map((entry) => entry.path)), [recents]);
  const catalogProjects = projects.filter((project) => !recentPaths.has(project.path));

  const selected = projects.find((project) => project.path === value)
    ?? recents.find((entry) => entry.path === value);
  const label =
    selected && 'name' in selected && selected.name
      ? selected.name
      : value
        ? projectDisplayName(value) ?? value
        : 'No repo';

  const selectProject = (path: string) => {
    onChange(path);
    setCustomMode(false);
    setCustomPath('');
    setBrowserOpen(false);
    setOpen(false);
  };

  const confirmCustomPath = () => {
    const trimmed = customPath.trim();
    if (!trimmed) return;
    selectProject(trimmed);
  };

  const openBrowser = () => {
    setOpen(false);
    setBrowserOpen(true);
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="composer-picker-trigger h-8 gap-1.5 px-2.5 max-w-[180px]">
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={`truncate text-[13px] ${value ? 'font-medium' : 'text-muted-foreground'}`}>
              {label}
            </span>
            <ChevronDown data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          {customMode ? (
            <div className="p-3 flex flex-col gap-2">
              <Input
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder="/Users/you/code/my-project"
                aria-label="Custom project path"
              />
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setCustomMode(false)}>
                  Back
                </Button>
                <Button size="sm" onClick={confirmCustomPath} disabled={!customPath.trim()}>
                  Use path
                </Button>
              </div>
            </div>
          ) : (
            <Command>
              <CommandInput placeholder="Search projects…" />
              <CommandList>
                <CommandEmpty>No project found.</CommandEmpty>
                {recents.length > 0 && (
                  <CommandGroup heading="Recents">
                    {recents.map((entry) => (
                      <CommandItem
                        key={entry.path}
                        value={`${entry.name ?? projectDisplayName(entry.path)} ${entry.path}`}
                        onSelect={() => selectProject(entry.path)}
                        data-checked={entry.path === value ? 'true' : undefined}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium truncate">
                            {entry.name ?? projectDisplayName(entry.path) ?? entry.path}
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate">{entry.path}</div>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {catalogProjects.length > 0 && (
                  <CommandGroup heading="Projects">
                    {catalogProjects.map((project) => (
                      <CommandItem
                        key={project.id}
                        value={`${project.name} ${project.path}`}
                        onSelect={() => selectProject(project.path)}
                        data-checked={project.path === value ? 'true' : undefined}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium truncate">{project.name}</div>
                          <div className="text-[11px] text-muted-foreground truncate">{project.path}</div>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem value="browse folders open" onSelect={openBrowser}>
                    <FolderOpen className="size-3.5" data-icon="inline-start" />
                    <span>Browse folders…</span>
                  </CommandItem>
                  <CommandItem value="custom path enter absolute" onSelect={() => setCustomMode(true)}>
                    Custom path…
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          )}
        </PopoverContent>
      </Popover>

      <FolderBrowser
        open={browserOpen}
        onSelect={selectProject}
        onCancel={() => setBrowserOpen(false)}
      />
    </>
  );
}
