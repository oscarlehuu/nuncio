import type { CrewProfileDto } from '@nuncio/core/crew-api';
import { ChevronDown, Settings2, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { withBase } from '@/lib/api-base';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function CrewProfilePicker({
  profiles,
  value,
  onChange,
  disabled,
  loading,
}: {
  profiles: CrewProfileDto[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <Button type="button" variant="ghost" disabled className="h-7 gap-1.5 px-2 text-ui">
        <UsersRound aria-hidden className="size-3.5" />
        Loading Crew…
      </Button>
    );
  }

  if (profiles.length === 0) {
    return (
      <Button asChild variant="ghost" className="h-7 gap-1.5 px-2 text-ui text-muted-foreground">
        <a href={withBase('/settings?section=crew-profiles')}>
          <Settings2 aria-hidden className="size-3.5" />
          Set up Crew
        </a>
      </Button>
    );
  }

  const selected = profiles.find((profile) => profile.id === value) ?? profiles[0];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          aria-label={`Crew profile: ${selected.name}`}
          className="h-7 max-w-[220px] gap-1.5 px-2 text-ui text-muted-foreground hover:text-foreground"
        >
          <UsersRound aria-hidden className="size-3.5" />
          <span className="truncate">{selected.name}</span>
          <ChevronDown aria-hidden className="size-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        <DropdownMenuRadioGroup value={selected.id} onValueChange={onChange}>
          {profiles.map((profile) => (
            <DropdownMenuRadioItem key={profile.id} value={profile.id}>
              <span className="truncate">{profile.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
