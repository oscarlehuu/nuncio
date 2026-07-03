import { useCallback, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TerminalPanel } from './terminal-panel';

interface TerminalDockProps {
  cwd?: string;
}

interface TerminalTab {
  key: string;
  label: string;
}

function createTabKey(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function TerminalDock({ cwd }: TerminalDockProps) {
  // Highest terminal number used so far. Mutated ONLY inside event handlers
  // (never in render or a state updater) so React StrictMode's double-invocation
  // of initializers/updaters cannot skip numbers.
  const lastNumberRef = useRef(1);
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [
    { key: createTabKey(), label: 'Terminal 1' },
  ]);
  const [activeKey, setActiveKey] = useState<string>(() => tabs[0]!.key);

  // Synchronous mirror of the latest committed tabs, so event handlers can read
  // current tabs without putting side effects in a state updater. Assigning a ref
  // during render is idempotent and StrictMode-safe.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const addTab = useCallback(() => {
    lastNumberRef.current += 1;
    const tab: TerminalTab = { key: createTabKey(), label: `Terminal ${lastNumberRef.current}` };
    setTabs((prev) => [...prev, tab]);
    setActiveKey(tab.key);
  }, []);

  const closeTab = useCallback((key: string) => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.key === key);
    if (index === -1) return;
    const remaining = current.filter((tab) => tab.key !== key);

    setTabs(remaining);
    setActiveKey((currentActive) => {
      if (currentActive !== key) return currentActive;
      if (remaining.length === 0) return '';
      const fallbackIndex = index > 0 ? index - 1 : 0;
      return remaining[Math.min(fallbackIndex, remaining.length - 1)]!.key;
    });
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1"
      >
        {tabs.map((tab) => {
          const isActive = tab.key === activeKey;
          return (
            <div
              key={tab.key}
              role="tab"
              aria-selected={isActive}
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-ui ${
                isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <button type="button" onClick={() => setActiveKey(tab.key)} className="whitespace-nowrap">
                {tab.label}
              </button>
              <button
                type="button"
                onClick={() => closeTab(tab.key)}
                aria-label={`Close ${tab.label}`}
                className="rounded p-0.5 hover:bg-muted"
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={addTab}
          aria-label="New terminal"
          className="shrink-0"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-ui text-muted-foreground">
            No terminals — click + to start one
          </div>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.key}
              className="h-full"
              style={{ display: tab.key === activeKey ? undefined : 'none' }}
            >
              <TerminalPanel cwd={cwd} onExit={() => closeTab(tab.key)} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
