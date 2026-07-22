import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  estimateMessageJsonBytes,
  fitsMessageJsonBudget,
  MAX_MESSAGE_JSON_BYTES,
  NON_ATTACHMENT_JSON_RESERVE_BYTES,
} from './use-message-attachments-budget';
import { useMessageAttachments, type PendingAttachment } from './use-message-attachments';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const MiB = 1024 * 1024;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('message attachment JSON budget', () => {
  it('accounts for base64 expansion so two individually valid near-10 MiB images are rejected', () => {
    const images = [
      { rawBytes: 10 * MiB - 1, mimeType: 'image/png' },
      { rawBytes: 10 * MiB - 1, mimeType: 'image/jpeg' },
    ];

    expect(estimateMessageJsonBytes(images)).toBeGreaterThan(MAX_MESSAGE_JSON_BYTES);
    expect(fitsMessageJsonBudget(images)).toBe(false);
  });

  it('still admits one image at the existing 10 MiB per-image ceiling', () => {
    expect(
      fitsMessageJsonBudget([{ rawBytes: 10 * MiB, mimeType: 'image/png' }]),
    ).toBe(true);
  });

  it('accepts exactly at a supplied body budget and rejects one byte below it', () => {
    const images = [{ rawBytes: 1024, mimeType: 'image/png' }];
    const exact = estimateMessageJsonBytes(images);

    expect(fitsMessageJsonBudget(images, exact)).toBe(true);
    expect(fitsMessageJsonBudget(images, exact - 1)).toBe(false);
  });

  it('includes JSON envelope/object UTF-8 overhead even for a zero-byte image', () => {
    const ascii = estimateMessageJsonBytes([{ rawBytes: 0, mimeType: 'image/png' }]);
    const unicode = estimateMessageJsonBytes([{ rawBytes: 0, mimeType: 'image/雪雪' }]);

    expect(ascii).toBeGreaterThan(NON_ATTACHMENT_JSON_RESERVE_BYTES);
    expect(unicode).toBeGreaterThan(ascii);
  });

  it('fails closed for negative and non-finite file sizes', () => {
    expect(fitsMessageJsonBudget([{ rawBytes: -1, mimeType: 'image/png' }])).toBe(false);
    expect(fitsMessageJsonBudget([{ rawBytes: Number.NaN, mimeType: 'image/png' }])).toBe(false);
  });

  it('releases aggregate admission when FileReader fails', async () => {
    class FailingFileReader {
      error = new Error('unreadable');
      result: string | ArrayBuffer | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;

      readAsDataURL() {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('FileReader', FailingFileReader);
    const file = { name: 'broken.png', type: 'image/png', size: 10 * MiB - 1 } as File;
    const { result } = renderHook(() => useMessageAttachments());
    let accepted: PendingAttachment[] = [];

    await act(async () => {
      accepted = await result.current.addFiles([file]);
    });

    expect(accepted).toEqual([]);
    expect(result.current.items).toEqual([]);
  });

  it('serializes overlapping batches so they cannot both reserve the same budget', async () => {
    class ArithmeticFileReader {
      error = null;
      result: string | ArrayBuffer | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;

      readAsDataURL() {
        queueMicrotask(() => {
          this.result = 'data:image/png;base64,AAAA';
          this.onload?.();
        });
      }
    }
    vi.stubGlobal('FileReader', ArithmeticFileReader);
    const nearLimit = (name: string) =>
      ({ name, type: 'image/png', size: 10 * MiB - 1 }) as File;
    const { result } = renderHook(() => useMessageAttachments());
    let first: PendingAttachment[] = [];
    let second: PendingAttachment[] = [];

    await act(async () => {
      [first, second] = await Promise.all([
        result.current.addFiles([nearLimit('one.png')]),
        result.current.addFiles([nearLimit('two.png')]),
      ]);
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(result.current.items).toHaveLength(1);
  });
});
