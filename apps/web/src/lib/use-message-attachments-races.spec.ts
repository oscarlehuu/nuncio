import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitsMessageJsonBudget } from './use-message-attachments-budget';
import { useMessageAttachments, type PendingAttachment } from './use-message-attachments';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const MiB = 1024 * 1024;

interface PendingRead {
  succeed(): void;
}

function installControlledFileReader(): PendingRead[] {
  const reads: PendingRead[] = [];
  class ControlledFileReader {
    error: Error | null = null;
    result: string | ArrayBuffer | null = null;
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;

    readAsDataURL() {
      reads.push({
        succeed: () => {
          this.result = 'data:image/png;base64,AAAA';
          this.onload?.();
        },
      });
    }
  }
  vi.stubGlobal('FileReader', ControlledFileReader);
  return reads;
}

function imageFile(name: string, size: number): File {
  return { name, type: 'image/png', size } as File;
}

function stagedImage(id: string, size: number): PendingAttachment {
  return {
    id,
    name: `${id}.png`,
    label: id,
    sourceBytes: size,
    attachment: { kind: 'image', mimeType: 'image/png', data: 'AAAA' },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('message attachment mutation races', () => {
  it('revalidates a delayed near-limit add after failed-send restore', async () => {
    const reads = installControlledFileReader();
    const restored = stagedImage('restored', 10 * MiB - 1);
    const { result } = renderHook(() => useMessageAttachments());
    let addPromise!: Promise<PendingAttachment[]>;

    await act(async () => {
      addPromise = result.current.addFiles([imageFile('delayed.png', 10 * MiB - 1)]);
      await Promise.resolve();
    });
    expect(reads).toHaveLength(1);

    act(() => result.current.restore([restored]));
    let accepted: PendingAttachment[] = [];
    await act(async () => {
      reads[0]!.succeed();
      accepted = await addPromise;
    });

    expect(accepted).toEqual([]);
    expect(result.current.items).toEqual([restored]);
    expect(fitsMessageJsonBudget(result.current.items.map((item) => ({
      rawBytes: item.sourceBytes,
      mimeType: item.attachment.mimeType,
    })))).toBe(true);
  });

  it('commits a delayed add against cleared current state without restoring old items', async () => {
    const reads = installControlledFileReader();
    const old = stagedImage('old', MiB);
    const { result } = renderHook(() => useMessageAttachments());
    act(() => result.current.restore([old]));
    let addPromise!: Promise<PendingAttachment[]>;

    await act(async () => {
      addPromise = result.current.addFiles([imageFile('new.png', 10 * MiB - 1)]);
      await Promise.resolve();
    });
    expect(reads).toHaveLength(1);

    act(() => result.current.clear());
    await act(async () => {
      reads[0]!.succeed();
      await addPromise;
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.name).toBe('new.png');
    expect(result.current.items.some((item) => item.id === old.id)).toBe(false);
  });

  it('serializes two delayed near-limit adds so only one is admitted', async () => {
    const reads = installControlledFileReader();
    const { result } = renderHook(() => useMessageAttachments());
    let firstPromise!: Promise<PendingAttachment[]>;
    let secondPromise!: Promise<PendingAttachment[]>;

    await act(async () => {
      firstPromise = result.current.addFiles([imageFile('one.png', 10 * MiB - 1)]);
      secondPromise = result.current.addFiles([imageFile('two.png', 10 * MiB - 1)]);
      await Promise.resolve();
    });
    expect(reads).toHaveLength(1);

    let first: PendingAttachment[] = [];
    let second: PendingAttachment[] = [];
    await act(async () => {
      reads[0]!.succeed();
      [first, second] = await Promise.all([firstPromise, secondPromise]);
    });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(reads).toHaveLength(1);
    expect(result.current.items).toHaveLength(1);
  });
});
