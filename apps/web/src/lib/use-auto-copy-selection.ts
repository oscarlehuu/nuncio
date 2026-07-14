import { useEffect, type RefObject } from 'react';
import { toast } from 'sonner';
import { copySelectionInside } from './auto-copy-selection';

/**
 * On mouseup/touchend inside `ref`, copy any non-empty selection that lives
 * wholly in that subtree. Used by chat transcript surfaces so a drag-select
 * lands on the clipboard without needing Cmd/Ctrl+C.
 */
export function useAutoCopySelection(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const handlePointerUp = () => {
      void copySelectionInside(root)
        .then((text) => {
          if (text) toast.success('Copied', { duration: 1000 });
        })
        .catch(() => {
          // clipboard may be unavailable (jsdom / insecure context) — silent
        });
    };

    root.addEventListener('mouseup', handlePointerUp);
    root.addEventListener('touchend', handlePointerUp);
    return () => {
      root.removeEventListener('mouseup', handlePointerUp);
      root.removeEventListener('touchend', handlePointerUp);
    };
  }, [ref]);
}
