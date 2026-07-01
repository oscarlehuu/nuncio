import type { AgentCapabilities } from '../agents/agents.types';
import type { ModelOptionDescriptorDto } from './model-options.types';

export interface ModelVariantDto {
  label: string;
  params: Array<{ id: string; value: string }>;
  isDefault?: boolean;
}

export interface ModelItemDto {
  id: string;
  name: string;
  sub?: string;
  badge?: string;
  cost?: string;
  contextWindow?: number;
  options?: ModelOptionDescriptorDto[];
  variants?: ModelVariantDto[];
}

export interface ModelGroupDto {
  id: string;
  name: string;
  sub?: string;
  badge?: string;
  models: ModelItemDto[];
}

export interface ModelProviderDto {
  id: string;
  name: string;
  sub?: string;
  icon?: string;
  badge?: string;
  unavailable?: boolean;
  capabilities?: AgentCapabilities;
  groups?: ModelGroupDto[];
}
