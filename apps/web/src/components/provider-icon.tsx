import type { SVGProps, ReactElement } from 'react';
import { providerMeta } from '../lib/model-providers';

type IconProps = SVGProps<SVGSVGElement>;

export const CursorIcon = (props: IconProps) => (
  <svg {...props} viewBox="0 0 466.73 532.09" fill="currentColor" aria-hidden="true">
    <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
  </svg>
);

export const PiIcon = (props: IconProps) => (
  <svg {...props} viewBox="0 0 800 800" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29V165.29ZM282.65 282.65V400H400V282.65H282.65Z"
      clipRule="evenodd"
    />
    <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36V400Z" />
  </svg>
);

const SVG_BY_PROVIDER: Record<string, (props: IconProps) => ReactElement> = {
  cursor: CursorIcon,
  pi: PiIcon,
};

interface ProviderIconProps {
  providerId: string;
  className?: string;
}

/**
 * Renders the branded SVG glyph for known providers (cursor, pi) and falls back
 * to the provider's character icon (from providerMeta) for unknown ones. SVGs
 * use fill="currentColor" so they adapt to light/dark themes.
 */
export function ProviderIcon({ providerId, className }: ProviderIconProps) {
  const Svg = SVG_BY_PROVIDER[providerId];
  if (Svg) return <Svg className={className} />;
  const fallback = providerMeta(providerId).icon;
  return <span className={className}>{fallback}</span>;
}
