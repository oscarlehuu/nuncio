export type TranscriptLinkTarget =
  | { kind: 'external'; href: string }
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'unknown' };

const EXTERNAL_SCHEME_RE = /^https?:\/\//i;
const BARE_WEB_RE = /^www\.[^\s/$.?#].[^\s]*$/i;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const LINE_SUFFIX_RE = /^(.*?)(?::(\d+)(?::\d+)?)$/;
const HASH_LINE_SUFFIX_RE = /^(.*?)(?:#L|#)(\d+)$/i;
const CODE_FILE_EXTENSION_RE =
  /\.(?:c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|json|kt|lock|lua|mjs|md|mdx|php|py|rb|rs|scss|sh|sql|swift|toml|ts|tsx|vue|xml|ya?ml)$/i;

export function normalizeExternalHref(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const withScheme = BARE_WEB_RE.test(value) ? `https://${value}` : value;
  if (!EXTERNAL_SCHEME_RE.test(withScheme)) return null;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function isTranscriptCodePathLike(raw: string): boolean {
  const value = stripWrappingPunctuation(raw.trim());
  if (!value || /\s/.test(value)) return false;
  if (normalizeExternalHref(value)) return false;
  if (SCHEME_RE.test(value) && !value.startsWith('file:')) return false;
  const withoutLine = stripLineSuffix(value).path;
  if (withoutLine.startsWith('file:')) return true;
  if (withoutLine.includes('/')) return true;
  return CODE_FILE_EXTENSION_RE.test(withoutLine);
}

export function resolveTranscriptLinkTarget(
  raw: string,
  workspaceRoot?: string,
): TranscriptLinkTarget {
  const external = normalizeExternalHref(raw);
  if (external) return { kind: 'external', href: external };

  if (!isTranscriptCodePathLike(raw)) return { kind: 'unknown' };

  const { path, line } = stripLineSuffix(stripWrappingPunctuation(raw.trim()));
  const normalized = normalizeFilePath(path, workspaceRoot);
  if (!normalized) return { kind: 'unknown' };
  return line === undefined
    ? { kind: 'file', path: normalized }
    : { kind: 'file', path: normalized, line };
}

function stripWrappingPunctuation(value: string): string {
  return value
    .replace(/^<(.+)>$/, '$1')
    .replace(/[),.;:]+$/, '');
}

function stripLineSuffix(value: string): { path: string; line?: number } {
  const hash = value.match(HASH_LINE_SUFFIX_RE);
  if (hash && hash[1]) {
    return { path: hash[1], line: Number(hash[2]) };
  }
  const colon = value.match(LINE_SUFFIX_RE);
  if (colon && colon[1] && !/^[a-zA-Z]:[\\/]/.test(value)) {
    return { path: colon[1], line: Number(colon[2]) };
  }
  return { path: value };
}

function normalizeFilePath(rawPath: string, workspaceRoot?: string): string | null {
  let path = rawPath.trim().replaceAll('\\', '/');
  if (path.startsWith('file:')) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return null;
    }
  }

  if (path.startsWith('/')) {
    if (!workspaceRoot) return path.replace(/^\/+/, '');
    const root = workspaceRoot.replaceAll('\\', '/').replace(/\/+$/, '');
    if (path === root) return '';
    if (!path.startsWith(`${root}/`)) return null;
    path = path.slice(root.length + 1);
  }

  path = path.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!path) return null;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
}
