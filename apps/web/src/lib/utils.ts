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
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
