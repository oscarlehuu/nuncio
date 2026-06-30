import { useEffect, useId, useRef } from 'react';
import mermaid from 'mermaid';
import { cn } from '@/lib/utils';

let mermaidInitialized = false;

function initMermaid(): void {
  if (mermaidInitialized) return;
  const isDark = document.documentElement.classList.contains('dark');
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'loose',
  });
  mermaidInitialized = true;
}

export function MermaidDiagram({ code, className }: { code: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renderId = useId().replace(/:/g, '');

  useEffect(() => {
    const body = code.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!body.trim()) return;

    initMermaid();
    let cancelled = false;

    void mermaid.render(`mermaid-${renderId}`, body).then(({ svg, bindFunctions }) => {
      if (cancelled || !containerRef.current) return;
      containerRef.current.innerHTML = svg;
      bindFunctions?.(containerRef.current);
    });

    return () => {
      cancelled = true;
    };
  }, [code, renderId]);

  return (
    <div
      ref={containerRef}
      className={cn(
        'my-2 overflow-x-auto rounded-md border border-border/40 bg-muted/15 p-3',
        '[&_svg]:mx-auto [&_svg]:max-w-full',
        className,
      )}
    />
  );
}
