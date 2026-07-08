import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ChunkErrorBoundaryProps {
  children: ReactNode;
}

interface ChunkErrorBoundaryState {
  failed: boolean;
}

/**
 * Catches render/import failures from the lazy islands (Settings, Changelog,
 * Terminal, Mermaid). After a redeploy a stale open tab's dynamic import of a
 * now-deleted hashed chunk rejects; without a boundary that rejection crashes
 * the whole React tree into a white screen. Here it degrades to a compact
 * inline notice with a Reload button that pulls the fresh build.
 *
 * Must sit OUTSIDE the Suspense it guards — a lazy import rejection surfaces as
 * an error the Suspense boundary re-throws, so only an error boundary above it
 * can catch it.
 */
export class ChunkErrorBoundary extends Component<
  ChunkErrorBoundaryProps,
  ChunkErrorBoundaryState
> {
  state: ChunkErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ChunkErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Chunk failed to load', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="p-4 text-ui-sm text-muted-foreground">
        <p className="mb-2">This part failed to load after an update.</p>
        <button
          type="button"
          onClick={() => location.reload()}
          className="underline underline-offset-2 hover:text-foreground transition-colors"
        >
          Reload
        </button>
      </div>
    );
  }
}
