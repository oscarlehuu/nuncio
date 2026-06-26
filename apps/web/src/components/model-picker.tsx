import { useEffect, useRef, useState } from 'react';
import { fetchModels } from '../lib/api';
import {
  DEFAULT_MODEL_ID,
  FALLBACK_PROVIDERS,
  modelById,
  type FlatModel,
  type ModelProvider,
} from '../lib/model-providers';

interface ModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
}

export function ModelPicker({ value, onChange }: ModelPickerProps) {
  const [providers, setProviders] = useState<ModelProvider[]>(FALLBACK_PROVIDERS);
  const [open, setOpen] = useState(false);
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const lookup = modelById(providers);
  const selected: FlatModel | undefined = lookup[value];

  useEffect(() => {
    void fetchModels().then(setProviders);
  }, []);

  useEffect(() => {
    const onDocClick = () => setOpen(false);
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && selected) {
      setOpenProvider(selected.providerId);
      setOpenGroup(selected.groupId);
    }
  };

  const selectModel = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const provider = openProvider ? providers.find((p) => p.id === openProvider) : undefined;
  const group = provider?.groups?.find((g) => g.id === openGroup);
  const q = search.trim().toLowerCase();

  return (
    <div ref={rootRef} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-bg-2 border border-border-soft rounded-md text-text-1 text-xs hover:bg-bg-3 hover:text-text-0 transition-colors"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
        <span className="text-text-2 text-[11px]">{selected?.providerName ?? 'Pi'}</span>
        <span className="text-text-3">·</span>
        <span className="text-text-0 font-medium">{selected?.name ?? 'Fable 5'}</span>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <>
          <ModelPanel className="bottom-[calc(100%+6px)] left-0 min-w-[220px]">
            {providers.map((p) => {
              const active = openProvider === p.id;
              const count = p.groups?.length ?? 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    if (p.unavailable) return;
                    setOpenProvider(active ? null : p.id);
                    if (!active) setOpenGroup(null);
                    setSearch('');
                  }}
                  className={`model-row w-full ${active ? 'active' : ''} ${p.unavailable ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span className="model-row-icon">{p.icon ?? '·'}</span>
                  <span className="flex-1 min-w-0 text-left">
                    <span className="block text-[13px] font-medium truncate">{p.name}</span>
                    <span className="block text-[10.5px] text-text-2 truncate">{p.sub}</span>
                  </span>
                  {count > 0 ? (
                    <span className="text-[10.5px] text-text-3 bg-bg-1 px-1.5 rounded-full">{count} groups</span>
                  ) : (
                    <span className="text-[9.5px] text-text-3 bg-bg-1 px-1 rounded">BYOK</span>
                  )}
                  <ChevronRightIcon />
                </button>
              );
            })}
          </ModelPanel>

          {provider && (
            <ModelPanel className="bottom-[calc(100%+6px)] left-[232px] min-w-[260px] max-md:left-0">
              <div className="flex items-center gap-1.5 px-2 py-1.5 mb-1.5 bg-bg-1 border border-border-soft rounded-md">
                <SearchIcon />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="Search models or providers"
                  className="flex-1 bg-transparent border-none outline-none text-xs text-text-0 placeholder:text-text-3"
                />
              </div>
              {(provider.groups ?? []).map((g) => {
                const filtered = g.models.filter(
                  (m) => !q || m.name.toLowerCase().includes(q) || (m.sub?.toLowerCase().includes(q) ?? false),
                );
                if (q && filtered.length === 0) return null;
                const active = openGroup === g.id;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setOpenGroup(active ? null : g.id)}
                    className={`model-row w-full ${active ? 'active' : ''}`}
                  >
                    <span className="model-row-icon">{g.name.slice(0, 1).toUpperCase()}</span>
                    <span className="flex-1 min-w-0 text-left">
                      <span className="block text-[13px] font-medium truncate">{g.name}</span>
                      <span className="block text-[10.5px] text-text-2 truncate">{g.sub}</span>
                    </span>
                    {g.badge && <span className="text-[9.5px] text-info bg-info/10 px-1 rounded">{g.badge}</span>}
                    <span className="text-[10.5px] text-text-3 bg-bg-1 px-1.5 rounded-full">
                      {q ? filtered.length : g.models.length}
                    </span>
                    <ChevronRightIcon />
                  </button>
                );
              })}
            </ModelPanel>
          )}

          {group && (
            <ModelPanel className="bottom-[calc(100%+6px)] left-[484px] min-w-[280px] max-md:left-0">
              <div className="px-2 py-1 pb-2 text-[10.5px] text-text-3 uppercase tracking-wider font-semibold">
                {provider?.name} · {group.name}
              </div>
              {group.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => selectModel(m.id)}
                  className={`model-row w-full ${m.id === value ? 'selected' : ''}`}
                >
                  <span className="flex-1 min-w-0 text-left">
                    <span className="block text-[13px] font-medium truncate">{m.name}</span>
                    <span className="block text-[10.5px] text-text-2 truncate">{m.sub}</span>
                  </span>
                  {m.badge && <span className="text-[9.5px] text-text-2 bg-bg-1 px-1 rounded">{m.badge}</span>}
                  {m.cost && <span className="text-[10px] text-text-3 font-mono">{m.cost}</span>}
                  {m.id === value && <CheckIcon />}
                </button>
              ))}
            </ModelPanel>
          )}
        </>
      )}
    </div>
  );
}

export { DEFAULT_MODEL_ID };

function ModelPanel({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <div
      className={`absolute z-30 bg-bg-2 border border-border rounded-[10px] shadow-[0_8px_32px_rgba(0,0,0,0.4)] p-1.5 ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`w-3 h-3 text-text-2 transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 text-text-3">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 text-text-2 shrink-0">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="w-3.5 h-3.5 text-accent shrink-0">
      <polyline points="20 6 9 17 4 12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
