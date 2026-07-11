import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Users } from 'lucide-react';
import {
  createCrewProfile,
  deleteCrewProfile,
  fetchCrewProfiles,
  updateCrewProfile,
  type CrewProfileDto,
  type CrewProfileInput,
} from '@nuncio/core/crew-api';
import { fetchModels } from '../../lib/api';
import type { ModelProvider } from '../../lib/model-providers';
import { Button } from '@/components/ui/button';
import { EditCrewProfileDialog } from './edit-crew-profile-dialog';

export function CrewProfilesSettingsSection() {
  const [profiles, setProfiles] = useState<CrewProfileDto[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [editing, setEditing] = useState<CrewProfileDto | 'new' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextProfiles, nextProviders] = await Promise.all([
        fetchCrewProfiles(),
        fetchModels().catch(() => []),
      ]);
      setProfiles(nextProfiles);
      setProviders(nextProviders);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load Crew profiles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (input: CrewProfileInput) => {
    const saved = editing === 'new'
      ? await createCrewProfile(input)
      : await updateCrewProfile(editing!.id, { ...input, expectedRevision: editing!.revision });
    setProfiles((current) => {
      const exists = current.some((profile) => profile.id === saved.id);
      return exists ? current.map((profile) => profile.id === saved.id ? saved : profile) : [...current, saved];
    });
    setEditing(null);
  };

  const remove = async (profile: CrewProfileDto) => {
    try {
      await deleteCrewProfile(profile.id);
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to delete Crew profile');
    }
  };

  return (
    <section aria-labelledby="crew-profiles-heading">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id="crew-profiles-heading" className="text-ui-lg font-semibold">Crew profiles</h2>
          <p className="mt-1 text-ui-sm text-muted-foreground">Saved role bindings apply to future runs. Active snapshots never change.</p>
        </div>
        <Button className="min-h-11 shrink-0" onClick={() => setEditing('new')}><Plus />New profile</Button>
      </div>
      {loading ? <p className="rounded-lg border p-4 text-ui text-muted-foreground">Loading Crew profiles…</p> : null}
      {error ? (
        <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-ui">
          <p>Failed to load Crew profiles: {error}</p>
          <Button variant="outline" className="mt-3 min-h-11" onClick={() => void load()}>Retry</Button>
        </div>
      ) : null}
      {!loading && !error && profiles.length === 0 ? (
        <div className="rounded-lg border bg-card p-5 text-center">
          <Users className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-2 font-medium">No Crew profiles yet</p>
          <p className="text-ui-sm text-muted-foreground">Create a Quality profile to bind Foreman, Builder, and Reviewer.</p>
        </div>
      ) : null}
      {!loading && !error && profiles.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border bg-card">
          {profiles.map((profile) => (
            <li key={profile.id} className="flex min-w-0 items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" title={profile.name}>{profile.name}</p>
                <p className="truncate text-ui-sm text-muted-foreground">Quality · revision {profile.revision} · {profile.definition.bindings.foreman.model} → {profile.definition.bindings.builder.model} → Verify → {profile.definition.bindings.reviewer.model}</p>
              </div>
              <Button variant="outline" className="min-h-11" onClick={() => setEditing(profile)}>Edit</Button>
              <Button variant="ghost" size="icon" className="size-11" aria-label={`Delete ${profile.name}`} onClick={() => void remove(profile)}><Trash2 /></Button>
            </li>
          ))}
        </ul>
      ) : null}
      <EditCrewProfileDialog
        profile={editing === 'new' ? null : editing}
        open={editing !== null}
        providers={providers}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        onSave={save}
      />
    </section>
  );
}
