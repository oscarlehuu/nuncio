import type { GitService } from '../../git/git.service';
import { providerIdForHost } from '../forges.registry';
import type { ForgeWebhookEvent } from '../forges.types';

export async function findWebhookProject(
  git: GitService,
  event: ForgeWebhookEvent,
  ownsPullRequest?: (projectPath: string) => boolean,
): Promise<string | null> {
  const projects = await git.listProjects();
  const matches: string[] = [];
  for (const project of projects) {
    try {
      const remote = await git.remoteInfo(project.path);
      if (
        providerIdForHost(remote.host) === event.provider &&
        remote.owner === event.owner &&
        remote.repo === event.repo
      ) {
        matches.push(project.path);
      }
    } catch {
      // Repositories without a supported origin cannot own a forge delivery.
    }
  }
  return matches.find((path) => ownsPullRequest?.(path)) ?? matches[0] ?? null;
}
