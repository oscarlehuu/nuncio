export interface EvidenceMediaRef {
  id: string;
  mimeType: 'image/png';
}

export interface EvidenceCapturedPayload {
  beforeRef?: EvidenceMediaRef;
  afterRef?: EvidenceMediaRef;
  route: string;
  viewport: { w: number; h: number };
  workspaceHead: string;
}

function evidenceRef(value: unknown): EvidenceMediaRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const ref = value as Record<string, unknown>;
  if (typeof ref.id !== 'string' || ref.mimeType !== 'image/png') return undefined;
  return { id: ref.id, mimeType: 'image/png' };
}

export function normalizeEvidenceCapturedPayload(
  value: unknown,
): EvidenceCapturedPayload | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const viewport = raw.viewport as Record<string, unknown> | undefined;
  const width = viewport?.w;
  const height = viewport?.h;
  const beforeRef = evidenceRef(raw.beforeRef);
  const afterRef = evidenceRef(raw.afterRef);
  if ((!beforeRef && !afterRef) || (beforeRef && afterRef)) return undefined;
  if (typeof raw.route !== 'string' || typeof raw.workspaceHead !== 'string') return undefined;
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return {
    ...(beforeRef ? { beforeRef } : { afterRef: afterRef! }),
    route: raw.route,
    viewport: { w: width, h: height },
    workspaceHead: raw.workspaceHead,
  };
}
