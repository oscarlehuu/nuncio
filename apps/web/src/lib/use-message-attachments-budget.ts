export interface StagedImageSize {
  rawBytes: number;
  mimeType: string;
}

export const MAX_MESSAGE_JSON_BYTES = 25 * 1024 * 1024;
export const NON_ATTACHMENT_JSON_RESERVE_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Estimated full JSON request bytes reserved by staged image attachments. */
export function estimateMessageJsonBytes(images: readonly StagedImageSize[]): number {
  const envelope = utf8Bytes(JSON.stringify({ attachments: [] }));
  let total = NON_ATTACHMENT_JSON_RESERVE_BYTES + envelope;
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (!image || !Number.isFinite(image.rawBytes) || image.rawBytes < 0) return Number.POSITIVE_INFINITY;
    if (index > 0) total += 1;
    total += utf8Bytes(JSON.stringify({ kind: 'image', mimeType: image.mimeType, data: '' }));
    total += 4 * Math.ceil(image.rawBytes / 3);
  }
  return total;
}

export function fitsMessageJsonBudget(
  images: readonly StagedImageSize[],
  budgetBytes = MAX_MESSAGE_JSON_BYTES,
): boolean {
  return estimateMessageJsonBytes(images) <= budgetBytes;
}
