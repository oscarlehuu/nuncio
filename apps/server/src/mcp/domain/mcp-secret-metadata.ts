import type { McpTransport } from './mcp.types';

export interface McpSecretMetadata {
  secretKeys: string[];
  secretArgIndexes: number[];
  secretUrlQueryKeys: string[];
}

export interface ParsedMcpSecretMetadata {
  metadata: McpSecretMetadata;
  status: 'valid' | 'corrupt';
}

export type McpSecretLocation =
  | { kind: 'record'; key: string }
  | { kind: 'arg'; index: number }
  | { kind: 'url-query'; key: string };

export function normalizeSecretMetadata(source: {
  secretKeys?: string[];
  secretArgIndexes?: number[];
  secretUrlQueryKeys?: string[];
}): McpSecretMetadata {
  return {
    secretKeys: uniqueStrings(source.secretKeys),
    secretArgIndexes: [
      ...new Set((source.secretArgIndexes ?? []).filter((value) => Number.isInteger(value) && value >= 0)),
    ],
    secretUrlQueryKeys: uniqueStrings(source.secretUrlQueryKeys),
  };
}

/** Existing rows stored a bare string array; newer rows store all secret locations. */
export function parseStoredSecretMetadata(stored: string): ParsedMcpSecretMetadata {
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
      return {
        metadata: normalizeSecretMetadata({ secretKeys: parsed }),
        status: 'valid',
      };
    }
    if (isSecretMetadataObject(parsed)) {
      return {
        metadata: normalizeSecretMetadata(parsed),
        status: 'valid',
      };
    }
  } catch {
    // The caller needs the corruption signal to recover ciphertext locations safely.
  }
  return { metadata: normalizeSecretMetadata({}), status: 'corrupt' };
}

export function mergeSecretMetadata(
  current: McpSecretMetadata,
  detected: Partial<McpSecretMetadata>,
): McpSecretMetadata {
  return normalizeSecretMetadata({
    secretKeys: [...current.secretKeys, ...(detected.secretKeys ?? [])],
    secretArgIndexes: [
      ...current.secretArgIndexes,
      ...(detected.secretArgIndexes ?? []),
    ],
    secretUrlQueryKeys: [
      ...current.secretUrlQueryKeys,
      ...(detected.secretUrlQueryKeys ?? []),
    ],
  });
}

export function serializeSecretMetadata(metadata: McpSecretMetadata): string {
  return JSON.stringify(metadata);
}

export function mapTransportSecrets(
  transport: McpTransport,
  metadata: McpSecretMetadata,
  map: (value: string, location: McpSecretLocation) => string,
): McpTransport {
  const secretKeys = new Set(metadata.secretKeys);
  const mapRecord = (record: Record<string, string> | undefined) =>
    record
      ? Object.fromEntries(
          Object.entries(record).map(([key, value]) => [
            key,
            secretKeys.has(key) ? map(value, { kind: 'record', key }) : value,
          ]),
        )
      : undefined;

  if (transport.type === 'stdio') {
    const secretIndexes = new Set(metadata.secretArgIndexes);
    const env = mapRecord(transport.env);
    return {
      ...transport,
      args: transport.args.map((value, index) =>
        secretIndexes.has(index) ? map(value, { kind: 'arg', index }) : value,
      ),
      ...(env ? { env } : {}),
    };
  }

  const headers = mapRecord(transport.headers);
  return {
    ...transport,
    url: mapUrlQueryValues(transport.url, new Set(metadata.secretUrlQueryKeys), map),
    ...(headers ? { headers } : {}),
  };
}

function mapUrlQueryValues(
  rawUrl: string,
  secretKeys: Set<string>,
  map: (value: string, location: McpSecretLocation) => string,
): string {
  if (secretKeys.size === 0) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    const entries = [...parsed.searchParams.entries()];
    parsed.search = '';
    for (const [key, value] of entries) {
      parsed.searchParams.append(
        key,
        secretKeys.has(key) ? map(value, { kind: 'url-query', key }) : value,
      );
    }
    return parsed.toString();
  } catch {
    const question = rawUrl.indexOf('?');
    if (question < 0) return rawUrl;
    const fragmentAt = rawUrl.indexOf('#', question + 1);
    const prefix = rawUrl.slice(0, question);
    const fragment = fragmentAt < 0 ? '' : rawUrl.slice(fragmentAt);
    const query = rawUrl.slice(question + 1, fragmentAt < 0 ? undefined : fragmentAt);
    const entries = [...new URLSearchParams(query).entries()];
    const rebuilt = new URLSearchParams();
    for (const [key, value] of entries) {
      rebuilt.append(
        key,
        secretKeys.has(key) ? map(value, { kind: 'url-query', key }) : value,
      );
    }
    return `${prefix}?${rebuilt.toString()}${fragment}`;
  }
}

function isSecretMetadataObject(value: unknown): value is Partial<McpSecretMetadata> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isOptionalArray(record.secretKeys, (entry) => typeof entry === 'string') &&
    isOptionalArray(record.secretArgIndexes, (entry) => typeof entry === 'number') &&
    isOptionalArray(record.secretUrlQueryKeys, (entry) => typeof entry === 'string')
  );
}

function isOptionalArray(
  value: unknown,
  matches: (entry: unknown) => boolean,
): boolean {
  return value === undefined || (Array.isArray(value) && value.every(matches));
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => typeof value === 'string'))];
}
