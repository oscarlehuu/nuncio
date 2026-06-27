import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Setting } from '../lib/settings-api';
import { SettingRow } from './setting-row';

interface SettingsViewProps {
  settings: Setting[];
  onUpdate: (key: string, value: string) => Promise<void>;
  onClear: (key: string) => Promise<void>;
  onBack: () => void;
}

/**
 * Settings page — DB-backed env config UI. Two sections (Providers / General).
 * Secrets are masked by the server; this view never sees raw secret values.
 * Editing a setting persists it to the DB (overriding env) and busts provider
 * caches server-side, so a rotated key takes effect without a restart.
 */
export function SettingsView({ settings, onUpdate, onClear, onBack }: SettingsViewProps) {
  const providers = settings.filter((s) => s.category === 'provider');
  const general = settings.filter((s) => s.category === 'general');

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border sticky top-0 bg-background z-10">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-[16px] font-semibold tracking-tight">Settings</h1>
      </header>

      <div className="flex-1 px-4 py-2 max-w-[640px] w-full mx-auto">
        <SettingsSection title="Providers" settings={providers} onUpdate={onUpdate} onClear={onClear} />
        <SettingsSection title="General" settings={general} onUpdate={onUpdate} onClear={onClear} />
        <p className="text-[11px] text-muted-foreground mt-6 leading-relaxed">
          Settings override environment variables at runtime. Secrets are encrypted at rest
          (AES-256-GCM) and never returned in plain text. Boot-only vars (NUNCIO_DATA_DIR, PORT,
          NUNCIO_SETTINGS_KEY) remain env-only.
        </p>
      </div>
    </section>
  );
}

function SettingsSection({
  title,
  settings,
  onUpdate,
  onClear,
}: {
  title: string;
  settings: Setting[];
  onUpdate: (key: string, value: string) => Promise<void>;
  onClear: (key: string) => Promise<void>;
}) {
  if (settings.length === 0) return null;
  return (
    <section className="mt-4 first:mt-0">
      <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-1">
        {title}
      </h2>
      <div>
        {settings.map((s) => (
          <SettingRow key={s.key} setting={s} onUpdate={onUpdate} onClear={onClear} />
        ))}
      </div>
    </section>
  );
}
