export interface ModelItemDto {
  id: string;
  name: string;
  sub?: string;
  badge?: string;
  cost?: string;
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
  groups?: ModelGroupDto[];
}
