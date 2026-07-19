/** Fetch helpers for the MCP Store REST API (`/api/mcp-servers`). */

export type McpTransport =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

export type McpOAuthStatus = 'none' | 'required' | 'connected';

export interface McpServerDto {
  id: string;
  name: string;
  description: string | null;
  transport: McpTransport;
  enabled: boolean;
  advertise: 'lazy' | 'full';
  projectPath: string | null;
  engines: string[] | null;
  auth: 'none' | 'oauth';
  oauthStatus: McpOAuthStatus;
  sources: string[];
  secretKeys: string[];
  scope: 'global' | 'project';
  createdAt: number;
  updatedAt: number;
}

export type McpImportSource = 'cursor' | 'claude' | 'codex';

interface McpImportPreviewEntry {
  candidate: {
    name: string;
    transport: McpTransport;
    source: string;
    projectPath: string | null;
    enabled: boolean;
    auth: 'none' | 'oauth';
    secretKeys: string[];
  };
  status: 'new' | 'existing';
  existingId?: string;
}

export interface McpImportPreview {
  source: McpImportSource;
  entries: McpImportPreviewEntry[];
}

export interface McpImportResult {
  source: McpImportSource;
  createdIds: string[];
  mergedIds: string[];
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  let detail = `${res.status}`;
  try {
    const body = (await res.json()) as { message?: string | string[] };
    if (body?.message) detail = Array.isArray(body.message) ? body.message.join(', ') : body.message;
  } catch {
    // plain status fallback
  }
  throw new Error(detail);
}

export async function fetchMcpServers(): Promise<McpServerDto[]> {
  const res = await fetch('/api/mcp-servers');
  await ensureOk(res);
  return res.json();
}

export async function updateMcpServer(
  id: string,
  patch: Partial<Pick<McpServerDto, 'name' | 'description' | 'enabled' | 'advertise' | 'engines'>>,
): Promise<McpServerDto> {
  const res = await fetch(`/api/mcp-servers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await ensureOk(res);
  return res.json();
}

export async function deleteMcpServer(id: string): Promise<void> {
  const res = await fetch(`/api/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await ensureOk(res);
}

export async function previewMcpImport(source: McpImportSource): Promise<McpImportPreview> {
  const res = await fetch('/api/mcp-servers/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, dryRun: true }),
  });
  await ensureOk(res);
  return res.json();
}

export async function applyMcpImport(source: McpImportSource): Promise<McpImportResult> {
  const res = await fetch('/api/mcp-servers/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  await ensureOk(res);
  return res.json();
}

export async function startMcpOAuth(
  id: string,
): Promise<{ authorizationUrl?: string; alreadyAuthorized?: boolean }> {
  const res = await fetch(`/api/mcp-servers/${encodeURIComponent(id)}/oauth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  await ensureOk(res);
  return res.json();
}
