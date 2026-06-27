import { useEffect, useState } from 'react';
import { ChevronDown, FolderGit2 } from 'lucide-react';
import { fetchProjects, type Project } from '../lib/projects';
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

interface ProjectPickerProps {
  value?: string;
  onChange: (path: string) => void;
}

export function ProjectPicker({ value, onChange }: ProjectPickerProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customPath, setCustomPath] = useState('');

  useEffect(() => {
    void fetchProjects().then(setProjects);
  }, []);

  const selected = projects.find((project) => project.path === value);
  const label = selected?.name ?? (value ? value.split('/').filter(Boolean).pop() ?? value : 'No repo');

  const selectProject = (path: string) => {
    onChange(path);
    setCustomMode(false);
    setCustomPath('');
    setOpen(false);
  };

  const confirmCustomPath = () => {
    const trimmed = customPath.trim();
    if (!trimmed) return;
    selectProject(trimmed);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-8 gap-1.5 px-2.5 max-w-[180px]">
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
              {projects.length > 0 && (
                <CommandGroup heading="Projects">
                  {projects.map((project) => (
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
                <CommandItem value="custom path enter absolute" onSelect={() => setCustomMode(true)}>
                  Custom path…
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
