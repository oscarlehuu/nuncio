declare module 'qrcode.react' {
  import type { SVGProps } from 'react';

  export interface QRCodeSVGProps extends SVGProps<SVGSVGElement> {
    value: string;
    size?: number;
    level?: 'L' | 'M' | 'Q' | 'H';
    marginSize?: number;
    bgColor?: string;
    fgColor?: string;
  }

  export function QRCodeSVG(props: QRCodeSVGProps): JSX.Element;
}
