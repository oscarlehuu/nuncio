import type { McpAuthMode, McpServerSource, McpTransport } from '../domain/mcp.types';

/** One server discovered in an external store's config, normalized to the canonical shape. */
export interface McpImportCandidate {
  name: string;
  transport: McpTransport;
  source: McpServerSource;
  projectPath: string | null;
  enabled: boolean;
  auth: McpAuthMode;
  secretKeys: string[];
  secretArgIndexes?: number[];
  secretUrlQueryKeys?: string[];
}

export type McpImportSourceId = 'cursor' | 'claude' | 'codex';

export interface McpImportPreviewEntry {
  candidate: McpImportCandidate;
  /** new = would create a row; existing = identity already in the store (provenance merge only). */
  status: 'new' | 'existing';
  existingId?: string;
}

export interface McpImportPreview {
  source: McpImportSourceId;
  entries: McpImportPreviewEntry[];
}

export interface McpImportResult {
  source: McpImportSourceId;
  createdIds: string[];
  mergedIds: string[];
}
