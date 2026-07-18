/** Deterministic UI-impact classification of a unified git diff.
 * Pure domain logic: no provider, no model judgment — the visual-gate
 * foundation. `uiFiles` is bounded; `uiFileCount` keeps the true total. */

export const MAX_UI_IMPACT_FILES = 50;

export interface CrewUiImpact {
  uiTouched: boolean;
  uiFiles: string[];
  uiFileCount: number;
}

const UI_EXTENSIONS = new Set([
  'tsx', 'jsx', 'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less', 'html',
]);
const SCRIPT_EXTENSIONS = new Set(['ts', 'js', 'mts', 'mjs', 'cts', 'cjs']);
const UI_PATH_SEGMENTS = new Set([
  'components', 'component', 'ui', 'screens', 'pages', 'views', 'layouts',
  'styles', 'theme', 'themes', 'design',
]);
const TAILWIND_CONFIG = /^tailwind\.config\.[a-z]+$/;

/** Extracts the new-side (`b/`) path of every file header in a unified git
 * diff. Headers start at column 0, so added/context body lines that merely
 * mention `diff --git` are never matched. Rename headers yield the
 * destination path; quoted paths (spaces, unicode) are unwrapped. */
export function extractDiffFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const rest = line.slice('diff --git '.length);
    const quoted = /"b\/(.+)"$/.exec(rest);
    const path = quoted?.[1] ?? / b\/(.+)$/.exec(rest)?.[1];
    if (path) files.push(path);
  }
  return files;
}

export function classifyUiImpact(diff: string): CrewUiImpact {
  const uiFiles = extractDiffFiles(diff).filter(isUiFile);
  return {
    uiTouched: uiFiles.length > 0,
    uiFiles: uiFiles.slice(0, MAX_UI_IMPACT_FILES),
    uiFileCount: uiFiles.length,
  };
}

function isUiFile(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const name = segments.at(-1)!;
  const extension = name.includes('.') ? name.split('.').at(-1)! : '';
  if (UI_EXTENSIONS.has(extension)) return true;
  if (TAILWIND_CONFIG.test(name)) return true;
  if (!SCRIPT_EXTENSIONS.has(extension)) return false;
  return segments.slice(0, -1).some((segment) => UI_PATH_SEGMENTS.has(segment));
}
