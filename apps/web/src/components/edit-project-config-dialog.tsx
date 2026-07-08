import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  type ProjectConfigDto,
  type UpsertProjectConfigInput,
  type VerifyAutoSteer,
  type WorktreePolicy,
} from '../lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const WORKTREE_OPTIONS: Array<{ value: WorktreePolicy | 'inherit'; label: string }> = [
  { value: 'inherit', label: 'Inherit global' },
  { value: 'always', label: 'Always new worktree' },
  { value: 'never', label: 'Never (work in place)' },
  { value: 'optional', label: 'Optional (per task)' },
];

const AUTO_STEER_OPTIONS: Array<{ value: VerifyAutoSteer; label: string }> = [
  { value: 'inherit', label: 'Inherit global' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

interface EditProjectConfigDialogProps {
  config: ProjectConfigDto | null;
  onOpenChange: (open: boolean) => void;
  onSave: (input: UpsertProjectConfigInput) => void | Promise<void>;
}

/**
 * Edit one project's overrides. Every field defaults to "inherit" (global) — an
 * explicit empty verify command clears the override (server patch semantics), so
 * we send the trimmed string (or '' to clear) rather than dropping the key.
 */
export function EditProjectConfigDialog({
  config,
  onOpenChange,
  onSave,
}: EditProjectConfigDialogProps) {
  const [verifyCommand, setVerifyCommand] = useState('');
  const [worktreePolicy, setWorktreePolicy] = useState<WorktreePolicy | 'inherit'>('inherit');
  const [autoSteer, setAutoSteer] = useState<VerifyAutoSteer>('inherit');
  const [maxRounds, setMaxRounds] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!config) return;
    setVerifyCommand(config.verifyCommand ?? '');
    setWorktreePolicy(config.worktreePolicy ?? 'inherit');
    setAutoSteer(config.verifyAutoSteer);
    setMaxRounds(config.verifyMaxRounds != null ? String(config.verifyMaxRounds) : '');
  }, [config]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    const rounds = maxRounds.trim();
    const input: UpsertProjectConfigInput = {
      path: config.path,
      verifyCommand: verifyCommand.trim(),
      worktreePolicy: worktreePolicy === 'inherit' ? null : worktreePolicy,
      verifyAutoSteer: autoSteer,
      verifyMaxRounds: rounds ? Math.max(1, Number(rounds) || 1) : null,
    };
    try {
      await onSave(input);
    } finally {
      setSaving(false);
    }
  };

  const worktreeLabel =
    WORKTREE_OPTIONS.find((o) => o.value === worktreePolicy)?.label ?? 'Inherit global';
  const autoSteerLabel = AUTO_STEER_OPTIONS.find((o) => o.value === autoSteer)?.label ?? 'Inherit global';

  return (
    <Dialog open={config !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate">{config?.name}</DialogTitle>
          <DialogDescription>
            Overrides apply above the global defaults. Leave a field on “Inherit” to follow the global
            setting.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field label="Verify command" htmlFor="pc-verify">
            <Input
              id="pc-verify"
              value={verifyCommand}
              onChange={(e) => setVerifyCommand(e.target.value)}
              placeholder="Inherit (.nuncio/verify → global)"
              className="font-mono text-ui"
            />
          </Field>

          <Field label="Worktree policy">
            <SelectMenu label={worktreeLabel}>
              {WORKTREE_OPTIONS.map((o) => (
                <DropdownMenuItem key={o.value} onClick={() => setWorktreePolicy(o.value)}>
                  {o.label}
                </DropdownMenuItem>
              ))}
            </SelectMenu>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Auto-steer verify">
              <SelectMenu label={autoSteerLabel}>
                {AUTO_STEER_OPTIONS.map((o) => (
                  <DropdownMenuItem key={o.value} onClick={() => setAutoSteer(o.value)}>
                    {o.label}
                  </DropdownMenuItem>
                ))}
              </SelectMenu>
            </Field>
            <Field label="Max steer rounds" htmlFor="pc-rounds">
              <Input
                id="pc-rounds"
                type="number"
                min={1}
                value={maxRounds}
                onChange={(e) => setMaxRounds(e.target.value)}
                placeholder="Inherit"
              />
            </Field>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SelectMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 w-full justify-between px-3">
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-ui font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
