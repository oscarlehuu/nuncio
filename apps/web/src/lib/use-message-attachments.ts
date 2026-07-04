import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { MessageAttachment } from './api';

/** One staged attachment plus the local metadata the tray needs to render it. */
export interface PendingAttachment {
  id: string;
  name: string;
  /** Human reference shown in the tray and inserted into the prompt, e.g. "image 1".
   * Numbered monotonically so a token like `[image 2]` never gets reused. */
  label: string;
  attachment: MessageAttachment;
}

/** Per-image upload ceiling — bounds request size and on-disk footprint. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Read a File into an ImageAttachment — raw base64, `data:` prefix stripped. */
function readImageFile(file: File): Promise<MessageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      const data = comma >= 0 ? result.slice(comma + 1) : result;
      resolve({ kind: 'image', mimeType: file.type || 'image/png', data });
    };
    reader.readAsDataURL(file);
  });
}

/** Pull image Files out of a paste/drop payload (files first, items as fallback). */
function imageFilesFromDataTransfer(dt: DataTransfer): File[] {
  const out: File[] = [];
  if (dt.files && dt.files.length > 0) {
    for (const file of Array.from(dt.files)) {
      if (file.type.startsWith('image/')) out.push(file);
    }
  }
  if (out.length === 0 && dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) out.push(file);
      }
    }
  }
  return out;
}

/**
 * Staging state for image attachments on a chat message, shared by every
 * composer. Keeps the reading/validation logic in one place; the UI is just the
 * paperclip button and the thumbnail tray. Non-images are ignored and oversized
 * images are dropped with a toast so a bad file never blocks a send.
 */
export function useMessageAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const idRef = useRef(0);

  const addFiles = useCallback(
    async (files: Iterable<File> | FileList | null | undefined): Promise<PendingAttachment[]> => {
      if (!files) return [];
      const images = Array.from(files as Iterable<File>).filter((f) => f.type.startsWith('image/'));
      let oversized = 0;
      const accepted: PendingAttachment[] = [];
      for (const file of images) {
        if (file.size > MAX_IMAGE_BYTES) {
          oversized += 1;
          continue;
        }
        try {
          const attachment = await readImageFile(file);
          idRef.current += 1;
          accepted.push({
            id: `att-${idRef.current}`,
            name: file.name || 'image',
            label: `image ${idRef.current}`,
            attachment,
          });
        } catch {
          // Unreadable file — skip it rather than fail the whole batch.
        }
      }
      if (accepted.length > 0) setItems((prev) => [...prev, ...accepted]);
      if (oversized > 0) {
        toast.error(`${oversized} image${oversized > 1 ? 's' : ''} skipped — over 10MB.`);
      }
      return accepted;
    },
    [],
  );

  const addFromDataTransfer = useCallback(
    (dt: DataTransfer) => addFiles(imageFilesFromDataTransfer(dt)),
    [addFiles],
  );

  /** Whether a paste/drop payload carries at least one image — lets callers
   * intercept image pastes while leaving plain-text pastes to the browser. */
  const hasImages = useCallback((dt: DataTransfer | null) => {
    return !!dt && imageFilesFromDataTransfer(dt).length > 0;
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  /** Re-stage previously cleared items — used to undo an optimistic clear when a send fails. */
  const restore = useCallback((restored: PendingAttachment[]) => {
    if (restored.length > 0) setItems((prev) => [...restored, ...prev]);
  }, []);

  const attachments = items.map((i) => i.attachment);

  return { items, attachments, addFiles, addFromDataTransfer, hasImages, remove, clear, restore };
}
