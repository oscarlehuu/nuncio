import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import type { CrewProfileDto, ResolvedCrewProfileDto } from '@nuncio/core/crew-api';
import { resolvedCrewTeam } from '../lib/crew-composer';
import type { CrewBranch, CrewProject } from '../lib/crew-projects';
import { Check, ChevronRight, CircleAlert, Settings2 } from 'lucide-react-native';
import { Card } from './ui/card';
import { Text } from './ui/text';

interface Props {
  profiles: CrewProfileDto[];
  projects: CrewProject[];
  branches: CrewBranch[];
  profileId: string;
  projectPath: string;
  baseBranch: string;
  resolution: ResolvedCrewProfileDto | null;
  loading: boolean;
  resolving: boolean;
  error: string | null;
  onProfileChange: (id: string) => void;
  onProjectChange: (path: string) => void;
  onBranchChange: (branch: string) => void;
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
      <ChoiceRow
        label="Base branch"
        empty="No selectable branches"
        items={props.branches.map((branch) => ({
          key: branch.name,
          label: branch.isDefault ? `${branch.name} · default` : branch.name,
        }))}
        value={props.baseBranch}
        onChange={props.onBranchChange}
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
              className={`min-h-11 flex-row items-center justify-center gap-2 rounded-xl border px-4 ${
                item.key === value ? 'border-primary bg-secondary' : 'border-border bg-card'
              }`}
            >
              <Text className="max-w-56 text-foreground" numberOfLines={1}>{item.label}</Text>
              {item.key === value ? <Check color="#eff0f1" size={15} /> : <ChevronRight color="#83868b" size={14} />}
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
  if (!props.branches.length || !props.baseBranch) return <Notice title="No base branch" body="Choose a project with a selectable Git branch, then retry." action="Try again" onPress={props.onRetry} />;
  if (props.resolving) return <Notice title="Resolving Crew" body="Checking live provider and model availability." />;
  if (props.resolution?.state === 'needs_setup') {
    const issue = props.resolution.issues.map((item) => item.message).join(' · ') || 'A required role is unavailable.';
    return <Notice title="Needs setup" body={issue} action="Open web settings" onPress={props.onOpenSetup} />;
  }
  if (props.resolution?.state === 'ready') {
    return (
      <Card className="gap-0 rounded-xl border-primary/40 px-4 py-3 shadow-none">
        <View className="flex-row items-center gap-2">
          <Check color="#4ade80" size={16} />
          <Text className="font-semibold text-foreground">Ready</Text>
        </View>
        {resolvedCrewTeam(props.resolution).map((member) => (
          <Text key={member} className="mt-1 text-sm text-muted-foreground">{member}</Text>
        ))}
      </Card>
    );
  }
  return <Notice title="Choose a Crew" body="Select a project and saved profile." />;
}

function Notice({ title, body, action, onPress }: { title: string; body: string; action?: string; onPress?: () => void }) {
  return (
    <Card className="gap-0 rounded-xl border-border px-4 py-3 shadow-none">
      <View className="flex-row items-center gap-2">
        {title === 'Crew unavailable' || title === 'Needs setup' ? (
          <CircleAlert color="#f5605b" size={16} />
        ) : (
          <Settings2 color="#9ca3af" size={16} />
        )}
        <Text className="font-semibold text-foreground">{title}</Text>
      </View>
      <Text className="mt-1 text-sm text-muted-foreground">{body}</Text>
      {action && onPress ? (
        <Pressable onPress={onPress} className="mt-2 min-h-11 justify-center self-start">
          <Text className="font-semibold text-primary">{action}</Text>
        </Pressable>
      ) : null}
    </Card>
  );
}
