import { useState } from 'react';

interface HomeViewProps {
  sessionCount: number;
  onSubmit: (prompt: string) => Promise<void>;
  loading?: boolean;
}

export function HomeView({ sessionCount, onSubmit, loading }: HomeViewProps) {
  const [prompt, setPrompt] = useState('');

  const handleSubmit = async () => {
    const text = prompt.trim();
    if (!text || loading) return;
    await onSubmit(text);
    setPrompt('');
  };

  return (
    <section className="flex-1 flex flex-col items-center justify-center p-6 overflow-y-auto">
      <div className="w-full max-w-[720px]">
        <div className="text-center mb-8">
          <h1 className="text-[28px] font-medium tracking-tight mb-2">What should I work on?</h1>
          <p className="text-text-1 text-[15px] max-w-[480px] mx-auto">
            Delegate a task — write code, fix bugs, open a PR. Your agents keep going while you&apos;re away.
          </p>
        </div>

        <div className="bg-bg-1 border border-border rounded-[14px] shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder="Ask Nuncio to build features, fix bugs, or work on your code…"
            rows={4}
            className="w-full bg-transparent px-4 pt-4 pb-2 resize-none outline-none text-[15px] placeholder:text-text-3"
          />
          <div className="flex items-center justify-between px-3 pb-3">
            <span className="text-xs text-text-2 px-2">Pi · Mock mode</span>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={loading || !prompt.trim()}
              className="w-9 h-9 rounded-lg bg-accent text-[#1a1208] flex items-center justify-center disabled:opacity-40 hover:bg-accent-hover transition-colors"
            >
              <SendIcon />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 justify-center mt-5 text-xs text-text-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-bg-2 border border-border-soft">
            Pi connected
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-bg-2 border border-border-soft">
            {sessionCount} session{sessionCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </section>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
