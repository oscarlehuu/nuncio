import { useEffect, useMemo, useState } from 'react';
import type { CrewProfileDto, CrewProfileInput, CrewRole, CrewRoleBinding } from '@nuncio/core/crew-api';
import type { ModelProvider } from '../../lib/model-providers';
import { ModelPicker } from '../model-picker';
import { crewProfileProviderCatalog } from './crew-profile-provider-catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const roles: CrewRole[] = ['foreman', 'builder', 'reviewer'];
const blankBinding = (): CrewRoleBinding => ({ provider: '', model: '' });

export function EditCrewProfileDialog({ profile, open, providers, onOpenChange, onSave }: {
  profile: CrewProfileDto | null;
  open: boolean;
  providers: ModelProvider[];
  onOpenChange: (open: boolean) => void;
  onSave: (input: CrewProfileInput) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [bindings, setBindings] = useState<Record<CrewRole, CrewRoleBinding>>({ foreman: blankBinding(), builder: blankBinding(), reviewer: blankBinding() });
  const [verifyCommand, setVerifyCommand] = useState('');
  const [verifyCap, setVerifyCap] = useState(2);
  const [reviewCap, setReviewCap] = useState(2);
  const [strictFresh, setStrictFresh] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const crewProviders = useMemo(() => crewProfileProviderCatalog(providers), [providers]);

  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? '');
    setBindings(profile?.definition.bindings ?? { foreman: blankBinding(), builder: blankBinding(), reviewer: blankBinding() });
    setVerifyCommand(profile?.definition.policy.verifyCommand ?? '');
    setVerifyCap(profile?.definition.policy.maxVerifyRetries ?? 2);
    setReviewCap(profile?.definition.policy.maxReviewRetries ?? 2);
    setStrictFresh(profile?.definition.policy.strictFreshFinalReviewer ?? true);
    setError(null);
  }, [open, profile]);

  const missingModels = useMemo(() => roles.filter((role) => {
    const binding = bindings[role];
    if (!binding.model) return false;
    return !crewProviders.some((provider) => provider.id === binding.provider && (provider.groups ?? []).some((group) => group.models.some((model) => model.id === binding.model)));
  }), [bindings, crewProviders]);
  const complete = name.trim() && roles.every((role) => bindings[role].provider && bindings[role].model);

  const save = async () => {
    if (!complete) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(), presetId: 'quality',
        definition: { bindings, policy: { verifyCommand: verifyCommand.trim() || null, maxVerifyRetries: verifyCap, maxReviewRetries: reviewCap, strictFreshFinalReviewer: strictFresh } },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Profile validation failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{profile ? `Edit ${profile.name}` : 'New Crew profile'}</DialogTitle>
          <DialogDescription>Quality uses one writer, deterministic verification, and an independent reviewer.</DialogDescription>
        </DialogHeader>
        <label className="grid gap-1 text-ui font-medium">Profile name<Input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="divide-y divide-border rounded-lg border">
          {roles.map((role) => (
            <div key={role} className="flex min-w-0 items-center justify-between gap-3 p-3">
              <div><p className="capitalize font-medium">{role}</p><p className="text-ui-sm text-muted-foreground">{role === 'builder' ? 'Workspace write' : 'Read only'}</p></div>
              <ModelPicker pairMode="engine+model" engine={bindings[role].provider || null} model={bindings[role].model || null} providers={crewProviders} autoPick={false} compact onPairChange={(provider, model) => setBindings((current) => ({ ...current, [role]: { provider: provider ?? '', model: model ?? '' } }))} />
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 p-3"><div><p className="font-medium">Nuncio Tester</p><p className="text-ui-sm text-muted-foreground">Deterministic · read only</p></div><span className="text-ui-sm text-muted-foreground">Project verify command</span></div>
        </div>
        {missingModels.length > 0 ? <p role="alert" className="text-ui-sm text-warning">Saved model unavailable for: {missingModels.join(', ')}.</p> : null}
        <label className="grid gap-1 text-ui font-medium">Verify command<Input className="font-mono" value={verifyCommand} onChange={(event) => setVerifyCommand(event.target.value)} placeholder="Project default" /></label>
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Max verify retries" value={verifyCap} onChange={setVerifyCap} />
          <NumberField label="Max review retries" value={reviewCap} onChange={setReviewCap} />
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3"><div><p className="text-ui font-medium">Fresh final reviewer</p><p className="text-ui-sm text-muted-foreground">Start a clean reviewer after feedback.</p></div><Switch checked={strictFresh} onCheckedChange={setStrictFresh} aria-label="Fresh final reviewer" /></div>
        {error ? <p role="alert" className="text-ui-sm text-destructive">{error}</p> : null}
        <DialogFooter><Button variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>Cancel</Button><Button className="min-h-11" disabled={!complete || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save profile'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="grid gap-1 text-ui font-medium">{label}<Input type="number" min={0} max={20} value={value} onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))} /></label>;
}
