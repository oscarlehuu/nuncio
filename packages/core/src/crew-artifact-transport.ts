import type { CrewArtifactDto, CrewArtifactRangeDto } from './crew-artifact-types';

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const finite = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum;

function utf8ByteCount(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) bytes += 1;
    else if (codeUnit <= 0x7ff) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function baseFrom(value: JsonRecord) {
  if (
    typeof value.id !== 'string' || typeof value.runId !== 'string' ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256) ||
    !integer(value.byteCount) || value.retentionState !== 'retained' ||
    !finite(value.createdAt) || !record(value.metadata)
  ) return null;
  return {
    id: value.id,
    runId: value.runId,
    sha256: value.sha256,
    byteCount: value.byteCount,
    retentionState: value.retentionState,
    createdAt: value.createdAt,
  } as const;
}

export function crewArtifactFrom(value: unknown): CrewArtifactDto | null {
  if (!record(value)) return null;
  const base = baseFrom(value);
  if (!base || !record(value.metadata)) return null;
  const metadata = value.metadata;
  if (value.kind === 'verify-log') {
    if (
      typeof metadata.workspaceHead !== 'string' || typeof metadata.passed !== 'boolean' ||
      !(metadata.exitCode === null || integer(metadata.exitCode)) ||
      !finite(metadata.durationMs) || typeof metadata.timedOut !== 'boolean' ||
      typeof metadata.outputOverflow !== 'boolean' ||
      typeof metadata.postBoundaryOk !== 'boolean'
    ) return null;
    return {
      ...base,
      kind: 'verify-log',
      metadata: {
        workspaceHead: metadata.workspaceHead,
        passed: metadata.passed,
        exitCode: metadata.exitCode,
        durationMs: metadata.durationMs,
        timedOut: metadata.timedOut,
        outputOverflow: metadata.outputOverflow,
        postBoundaryOk: metadata.postBoundaryOk,
      },
    };
  }
  if (value.kind === 'workspace-diff') {
    if (
      typeof metadata.workspaceHead !== 'string' || typeof metadata.baseHead !== 'string' ||
      typeof metadata.truncated !== 'boolean'
    ) return null;
    return {
      ...base,
      kind: 'workspace-diff',
      metadata: {
        workspaceHead: metadata.workspaceHead,
        baseHead: metadata.baseHead,
        truncated: metadata.truncated,
      },
    };
  }
  return null;
}

export function crewArtifactRangeFrom(
  value: unknown,
  expected: { artifactId: string; offset: number; limit: number },
): CrewArtifactRangeDto | null {
  if (
    !record(value) || value.artifactId !== expected.artifactId ||
    value.offset !== expected.offset || !integer(value.offset) ||
    !integer(value.nextOffset) || value.nextOffset < value.offset ||
    value.nextOffset > value.offset + expected.limit ||
    typeof value.eof !== 'boolean' || typeof value.text !== 'string' ||
    (!value.eof && value.nextOffset === value.offset) ||
    (value.text.length === 0) !== (value.nextOffset === value.offset) ||
    utf8ByteCount(value.text) !== value.nextOffset - value.offset
  ) return null;
  return {
    artifactId: value.artifactId,
    offset: value.offset,
    nextOffset: value.nextOffset,
    eof: value.eof,
    text: value.text,
  };
}
