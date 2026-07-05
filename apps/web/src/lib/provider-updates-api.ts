export type ProviderToolId = 'pi' | 'codex';
export type ProviderUpdateStatus = 'unknown' | 'current' | 'behind_latest';

export interface ProviderUpdateStatusDto {
  provider: ProviderToolId;
  name: string;
  currentVersion: string | null;
  latestVersion: string | null;
  status: ProviderUpdateStatus;
  canUpdate: boolean;
  updateCommand: string | null;
  message: string | null;
  checkedAt: string;
}

export interface ProviderUpdatesDto {
  enabled: boolean;
  providers: ProviderUpdateStatusDto[];
}

export interface ProviderUpdateRunResultDto {
  provider: ProviderToolId;
  status: 'succeeded' | 'failed' | 'unchanged';
  message: string;
  output: string | null;
  providerStatus: ProviderUpdateStatusDto;
}

export async function fetchProviderUpdates(): Promise<ProviderUpdatesDto> {
  const res = await fetch('/api/provider-updates');
  if (!res.ok) throw new Error('Failed to load provider updates');
  return res.json();
}

export async function updateProviderTool(
  provider: ProviderToolId,
): Promise<ProviderUpdateRunResultDto> {
  const res = await fetch(`/api/provider-updates/${provider}/update`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to update provider tool');
  return res.json();
}
