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
