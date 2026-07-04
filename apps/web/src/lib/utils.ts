import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The named UI type scale (index.css @theme --text-*) produces text-<name>
// utilities that tailwind-merge cannot classify on its own — unknown text-*
// values are treated as text COLOR, so a `text-ui-xs` passed via className
// would wrongly evict color classes like `text-primary-foreground`.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        { text: ['ui-xs', 'ui-sm', 'ui', 'ui-lg', 'body', 'md', 'lg', 'title'] },
      ],
      // Named elevation shadows (index.css @theme --shadow-e*). Register them as
      // box-shadow members so `shadow-e1` and `shadow-e2` on one element merge
      // (last wins) instead of being misread as shadow-color and both kept.
      shadow: [{ shadow: ['e0', 'e1', 'e2', 'e3'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
