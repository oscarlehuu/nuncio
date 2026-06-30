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

export const CodexIcon = (props: IconProps) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M9.37088 2.18576C11.1759 1.70239 13.0087 2.19059 14.3229 3.32227C16.0284 2.99798 17.8626 3.49276 19.1849 4.81496C20.5066 6.13684 21 7.96945 20.6766 9.67409C21.8096 10.9886 22.2977 12.823 21.8141 14.629C21.3301 16.4355 19.9888 17.7788 18.35 18.3506C17.7783 19.9889 16.4362 21.3295 14.6302 21.8138C12.8243 22.2976 10.9899 21.8091 9.67535 20.6763C7.97048 21.0002 6.13741 20.5067 4.81526 19.1846C3.49332 17.8624 2.99758 16.0289 3.32161 14.3235C2.18976 13.0088 1.70243 11.1746 2.18606 9.36962C2.67009 7.56414 4.00987 6.21916 5.64825 5.647C6.22058 4.009 7.56548 2.66963 9.37088 2.18576ZM12.9805 13.4704C12.4393 13.4707 12.0002 13.9097 12.0001 14.4509C12.0001 14.9922 12.4392 15.4311 12.9805 15.4313H15.9219C16.4633 15.4313 16.9023 14.9924 16.9023 14.4509C16.9022 13.9095 16.4633 13.4704 15.9219 13.4704H12.9805ZM9.40918 9.04408C9.13045 8.58016 8.52809 8.42952 8.06394 8.70801C7.60003 8.98663 7.44965 9.5891 7.72787 10.0533L8.89502 11.9998L7.72787 13.9463C7.44943 14.4104 7.60008 15.0128 8.06394 15.2915C8.52819 15.5701 9.13053 15.4196 9.40918 14.9555L10.8798 12.5044C11.0661 12.1939 11.0661 11.8057 10.8798 11.4952L9.40918 9.04408Z"
    />
  </svg>
);

export const GitHubIcon = (props: IconProps) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.579.688.481C19.138 20.164 22 16.418 22 12c0-5.523-4.477-10-10-10z"
    />
  </svg>
);

export const GitLabIcon = (props: IconProps) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M22.65 14.39L12 22.13 1.35 14.39a.833.833 0 01-.3-.92l2.35-7.24a.831.831 0 01.79-.58h.02c.32 0 .6.19.71.49L7 12.3h10l2.18-6.16c.11-.3.39-.49.71-.49h.02c.34 0 .65.23.79.58l2.35 7.24a.834.834 0 01-.3.92-.003.003 0 01-.1.003zM12 22.13l-5-15.13h10l-5 15.13z"
    />
  </svg>
);

const SVG_BY_PROVIDER: Record<string, (props: IconProps) => ReactElement> = {
  codex: CodexIcon,
  cursor: CursorIcon,
  pi: PiIcon,
  github: GitHubIcon,
  gitlab: GitLabIcon,
};

interface ProviderIconProps {
  providerId: string;
  className?: string;
}

/**
 * Renders the branded SVG glyph for known providers (codex, cursor, pi) and falls back
 * to the provider's character icon (from providerMeta) for unknown ones. SVGs
 * use fill="currentColor" so they adapt to light/dark themes.
 */
export function ProviderIcon({ providerId, className }: ProviderIconProps) {
  const Svg = SVG_BY_PROVIDER[providerId];
  if (Svg) return <Svg className={className} data-provider-icon={providerId} />;
  const fallback = providerMeta(providerId).icon;
  return (
    <span className={className} data-provider-icon={providerId}>
      {fallback}
    </span>
  );
}
