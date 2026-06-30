export const PROJECT_PREFERENCE_STORAGE_KEY = 'nuncio-project-preference';
export const MAX_RECENT_PROJECTS = 8;

const NUNCIO_SESSION_BRANCH_PATTERN = /^nuncio\/[0-9a-f]{8}-/i;

export type RecentProject = {
  path: string;
  name?: string;
};

export type ProjectPreference = {
  recentProjects: RecentProject[];
  lastProjectPath?: string;
  lastBranchByProject?: Record<string, string>;
};

const EMPTY: ProjectPreference = { recentProjects: [] };

export function isNuncioSessionBranch(branch: string | undefined): boolean {
  return Boolean(branch && NUNCIO_SESSION_BRANCH_PATTERN.test(branch));
}

export function loadProjectPreference(storage: Storage = localStorage): ProjectPreference {
  try {
    const raw = storage.getItem(PROJECT_PREFERENCE_STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as ProjectPreference;
    return {
      recentProjects: Array.isArray(parsed.recentProjects) ? parsed.recentProjects : [],
      lastProjectPath: parsed.lastProjectPath,
      lastBranchByProject: parsed.lastBranchByProject,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveProjectPreference(
  pref: ProjectPreference,
  storage: Storage = localStorage,
): void {
  storage.setItem(PROJECT_PREFERENCE_STORAGE_KEY, JSON.stringify(pref));
}

export function recordProjectSelection(
  path: string,
  name?: string,
  storage: Storage = localStorage,
): void {
  const pref = loadProjectPreference(storage);
  const filtered = pref.recentProjects.filter((entry) => entry.path !== path);
  const entry: RecentProject = name ? { path, name } : { path };
  saveProjectPreference(
    {
      ...pref,
      recentProjects: [entry, ...filtered].slice(0, MAX_RECENT_PROJECTS),
      lastProjectPath: path,
    },
    storage,
  );
}

export function recordBranchSelection(
  projectPath: string,
  branch: string,
  storage: Storage = localStorage,
): void {
  if (isNuncioSessionBranch(branch)) return;

  const pref = loadProjectPreference(storage);
  saveProjectPreference(
    {
      ...pref,
      lastBranchByProject: { ...pref.lastBranchByProject, [projectPath]: branch },
    },
    storage,
  );
}

export function resolveWorkspacePreference(storage: Storage = localStorage): {
  projectPath?: string;
  baseBranch?: string;
} {
  const pref = loadProjectPreference(storage);
  if (!pref.lastProjectPath) return {};
  const baseBranch = pref.lastBranchByProject?.[pref.lastProjectPath];
  return {
    projectPath: pref.lastProjectPath,
    baseBranch: isNuncioSessionBranch(baseBranch) ? undefined : baseBranch,
  };
}
