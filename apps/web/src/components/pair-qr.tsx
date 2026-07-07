import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Renders the pairing payload as a scannable QR plus a copyable text fallback.
 * The QR tile is fixed dark-on-white with a quiet zone regardless of app theme —
 * scanners need contrast and a light margin, so it does NOT follow the theme.
 * Lazy-loaded so the qrcode.react dep stays out of the settings entry bundle.
 */
export default function PairQr({
  payload,
  dimmed,
  copyDisabled,
}: {
  payload: string;
  dimmed?: boolean;
  /** Blocked while the code is stale (a replacement is being minted). */
  copyDisabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context); the code stays readable below.
    }
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={`rounded-lg bg-white p-4 shadow-e0 transition-opacity ${
          dimmed ? 'opacity-40' : 'opacity-100'
        }`}
      >
        <QRCodeSVG
          value={payload}
          size={196}
          level="M"
          marginSize={2}
          bgColor="#ffffff"
          fgColor="#0a0a0a"
          aria-label="Pairing QR code"
        />
      </div>
      <div className="flex w-full max-w-sm items-start gap-1.5">
        <code className="min-w-0 flex-1 break-all rounded bg-muted/40 px-2 py-1.5 text-ui font-mono text-muted-foreground">
          {payload}
        </code>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 flex-shrink-0 px-2.5 text-ui"
          onClick={handleCopy}
          disabled={copyDisabled}
          aria-label="Copy pairing payload"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}
