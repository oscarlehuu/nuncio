import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useMessageAttachments } from './use-message-attachments';
import { appendImageTokens, stripImageToken } from './image-reference-token';

/**
 * Image staging for a composer, wired to its prompt text: adding an image
 * appends its `[image N]` reference to the prompt (so the agent can tie prose to
 * the image) and removing the thumbnail strips that reference back out. Drop-in
 * replacement for {@link useMessageAttachments} — same surface, plus the token
 * side effects — so a composer opts in by passing its text setter.
 */
export function useComposerAttachments(setText: Dispatch<SetStateAction<string>>) {
  const base = useMessageAttachments();
  const { addFiles: baseAddFiles, addFromDataTransfer: baseAddFromDataTransfer, remove: baseRemove } =
    base;

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
      const item = base.items.find((i) => i.id === id);
      baseRemove(id);
      if (item) setText((t) => stripImageToken(t, item.label));
    },
    [base.items, baseRemove, setText],
  );

  return { ...base, addFiles, addFromDataTransfer, remove };
}
