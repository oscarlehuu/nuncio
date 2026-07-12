import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import { useMessageAttachments } from './use-message-attachments';
import { appendImageTokens, stripImageToken } from './image-reference-token';

const UNSUPPORTED_IMAGE_MESSAGE =
  'This provider does not accept images yet. Switch to Pi or another image-capable model to paste screenshots.';

/**
 * Image staging for a composer, wired to its prompt text: adding an image
 * appends its `[image N]` reference to the prompt (so the agent can tie prose to
 * the image) and removing the thumbnail strips that reference back out. Drop-in
 * replacement for {@link useMessageAttachments} — same surface, plus the token
 * side effects — so a composer opts in by passing its text setter.
 */
export function useComposerAttachments(setText: Dispatch<SetStateAction<string>>) {
  const base = useMessageAttachments();
  const {
    addFiles: baseAddFiles,
    addFromDataTransfer: baseAddFromDataTransfer,
    hasImages: baseHasImages,
    remove: baseRemove,
    clear: baseClear,
    items,
  } = base;

  const addFiles = useCallback(
    async (files: Parameters<typeof baseAddFiles>[0]) => {
      const added = await baseAddFiles(files);
      if (added.length > 0) setText((t) => appendImageTokens(t, added.map((i) => i.label)));
      return added;
    },
    [baseAddFiles, setText],
  );

  const addFromDataTransfer = useCallback(
    async (dt: DataTransfer) => {
      const added = await baseAddFromDataTransfer(dt);
      if (added.length > 0) setText((t) => appendImageTokens(t, added.map((i) => i.label)));
      return added;
    },
    [baseAddFromDataTransfer, setText],
  );

  const remove = useCallback(
    (id: string) => {
      const item = items.find((i) => i.id === id);
      baseRemove(id);
      if (item) setText((t) => stripImageToken(t, item.label));
    },
    [items, baseRemove, setText],
  );

  /** Drop every staged image and its prompt token when a model capability changes. */
  const clearWithTokens = useCallback(() => {
    const labels = items.map((item) => item.label);
    baseClear();
    if (labels.length > 0) {
      setText((text) => labels.reduce((next, label) => stripImageToken(next, label), text));
    }
  }, [items, baseClear, setText]);

  const handlePaste = useCallback(
    (
      event: { clipboardData: DataTransfer | null; preventDefault: () => void },
      canAttachImages: boolean,
    ) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData || !baseHasImages(clipboardData)) return false;
      event.preventDefault();
      if (!canAttachImages) {
        toast.error(UNSUPPORTED_IMAGE_MESSAGE);
        return true;
      }
      void addFromDataTransfer(clipboardData);
      return true;
    },
    [addFromDataTransfer, baseHasImages],
  );

  return { ...base, addFiles, addFromDataTransfer, handlePaste, remove, clearWithTokens };
}
