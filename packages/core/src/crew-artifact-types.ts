interface CrewArtifactBase {
  id: string;
  runId: string;
  sha256: string;
  byteCount: number;
  retentionState: 'retained';
  createdAt: number;
}

export interface CrewVerifyArtifactDto extends CrewArtifactBase {
  kind: 'verify-log';
  metadata: {
    workspaceHead: string;
    passed: boolean;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    outputOverflow: boolean;
    postBoundaryOk: boolean;
  };
}

export interface CrewWorkspaceDiffArtifactDto extends CrewArtifactBase {
  kind: 'workspace-diff';
  metadata: {
    workspaceHead: string;
    baseHead: string;
    truncated: boolean;
    /** Deterministic UI-impact classification; absent on pre-classification servers. */
    uiTouched?: boolean;
    uiFileCount?: number;
  };
}

export type CrewArtifactDto = CrewVerifyArtifactDto | CrewWorkspaceDiffArtifactDto;

export interface CrewArtifactRangeDto {
  artifactId: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  text: string;
}
