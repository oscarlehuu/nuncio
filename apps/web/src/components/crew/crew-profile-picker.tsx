import type { CrewProfileDto } from '@nuncio/core/crew-api';

export function CrewProfilePicker({
  profiles,
  value,
  onChange,
  disabled,
}: {
  profiles: CrewProfileDto[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-ui text-muted-foreground">
      <span className="sr-only">Crew profile</span>
      <select
        aria-label="Crew profile"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || profiles.length === 0}
        className="min-h-11 max-w-[260px] truncate rounded-md border border-border bg-background px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {profiles.length === 0 ? <option value="">No profiles</option> : null}
        {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
    </label>
  );
}
