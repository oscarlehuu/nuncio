import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type { CrewProfileDto, ResolvedCrewProfileDto } from '@nuncio/core/crew-api';
import { resolvedCrewTeam } from '../lib/crew-composer';
import type { CrewProject } from '../lib/crew-projects';

interface Props {
  profiles: CrewProfileDto[];
  projects: CrewProject[];
  profileId: string;
  projectPath: string;
  resolution: ResolvedCrewProfileDto | null;
  loading: boolean;
  resolving: boolean;
  error: string | null;
  onProfileChange: (id: string) => void;
  onProjectChange: (path: string) => void;
  onRetry: () => void;
  onOpenSetup: () => void;
}

export function CrewComposerOptions(props: Props) {
  if (props.loading) {
    return <ActivityIndicator className="mt-6" accessibilityLabel="Loading Crew options" />;
  }
  return (
    <View className="mt-5 gap-4">
      <ChoiceRow
        label="Project"
        empty="No projects found"
        items={props.projects.map((project) => ({ key: project.path, label: project.name }))}
        value={props.projectPath}
        onChange={props.onProjectChange}
      />
      <ChoiceRow
        label="Crew profile"
        empty="No saved profiles"
        items={props.profiles.map((profile) => ({ key: profile.id, label: profile.name }))}
        value={props.profileId}
        onChange={props.onProfileChange}
      />
      <ResolutionCard {...props} />
    </View>
  );
}

function ChoiceRow({
  label,
  empty,
  items,
  value,
  onChange,
}: {
  label: string;
  empty: string;
  items: Array<{ key: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View>
      <Text className="mb-2 text-sm text-muted-foreground">{label}</Text>
      {items.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
          {items.map((item) => (
            <Pressable
              key={item.key}
              accessibilityRole="radio"
              accessibilityState={{ checked: item.key === value }}
              onPress={() => onChange(item.key)}
              className={`min-h-11 justify-center rounded-lg border px-4 ${
                item.key === value ? 'border-primary bg-secondary' : 'border-border bg-card'
              }`}
            >
              <Text className="max-w-56 text-foreground" numberOfLines={1}>{item.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : <Text className="text-sm text-muted-foreground">{empty}</Text>}
    </View>
  );
}

function ResolutionCard(props: Props) {
  if (props.error) return <Notice title="Crew unavailable" body={props.error} action="Try again" onPress={props.onRetry} />;
  if (!props.profiles.length) return <Notice title="No Crew profile" body="Create a profile in the web app first." action="Open web settings" onPress={props.onOpenSetup} />;
  if (!props.projects.length) return <Notice title="No project" body="Add a project root in the web app, then retry." action="Try again" onPress={props.onRetry} />;
  if (props.resolving) return <Notice title="Resolving Crew" body="Checking live provider and model availability." />;
  if (props.resolution?.state === 'needs_setup') {
    const issue = props.resolution.issues.map((item) => item.message).join(' · ') || 'A required role is unavailable.';
    return <Notice title="Needs setup" body={issue} action="Open web settings" onPress={props.onOpenSetup} />;
  }
  if (props.resolution?.state === 'ready') {
    return (
      <View className="rounded-lg border border-primary/40 bg-card px-4 py-3">
        <Text className="font-semibold text-foreground">Ready</Text>
        {resolvedCrewTeam(props.resolution).map((member) => (
          <Text key={member} className="mt-1 text-sm text-muted-foreground">{member}</Text>
        ))}
      </View>
    );
  }
  return <Notice title="Choose a Crew" body="Select a project and saved profile." />;
}

function Notice({ title, body, action, onPress }: { title: string; body: string; action?: string; onPress?: () => void }) {
  return (
    <View className="rounded-lg border border-border bg-card px-4 py-3">
      <Text className="font-semibold text-foreground">{title}</Text>
      <Text className="mt-1 text-sm text-muted-foreground">{body}</Text>
      {action && onPress ? (
        <Pressable onPress={onPress} className="mt-2 min-h-11 justify-center self-start">
          <Text className="font-semibold text-primary">{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
