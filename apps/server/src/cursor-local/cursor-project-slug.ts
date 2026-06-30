import { resolve } from 'node:path';

/** Map an absolute workspace path to the Cursor projects folder slug. */
export function toProjectSlug(absPath: string): string {
  const normalized = resolve(absPath).replace(/\/+$/, '');
  const withoutLeading = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  const segments = withoutLeading.split('/').map((segment) => segment.replace(/^\.+/, ''));
  return segments.join('-');
}

export function agentTranscriptsRoot(homeDir: string): string {
  return `${homeDir}/.cursor/projects`;
}

export function transcriptDirForChat(homeDir: string, projectSlug: string, chatId: string): string {
  return `${agentTranscriptsRoot(homeDir)}/${projectSlug}/agent-transcripts/${chatId}`;
}
