import type { GitService } from '../../git/git.service';
import { providerIdForHost } from '../forges.registry';
import type { ForgeWebhookEvent } from '../forges.types';

export async function findWebhookProject(
  git: GitService,
  event: ForgeWebhookEvent,
  ownsPullRequest?: (projectPath: string) => boolean | 'live' | 'archived',
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
  let archivedOwner: string | null = null;
  for (const path of matches) {
    const ownership = ownsPullRequest?.(path);
    if (ownership === true || ownership === 'live') return path;
    if (ownership === 'archived' && archivedOwner === null) archivedOwner = path;
  }
  return archivedOwner ?? matches[0] ?? null;
}
