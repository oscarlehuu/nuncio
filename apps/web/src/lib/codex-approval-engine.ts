export function isCodexApprovalEngine(
  providerId?: string | null,
  modelId?: string | null,
): boolean {
  if (providerId === 'codex') return true;
  return !providerId && modelId?.startsWith('codex:') === true;
}
