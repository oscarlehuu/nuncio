import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { Setting } from '../lib/settings-api';

interface SettingRowProps {
  setting: Setting;
  onUpdate: (key: string, value: string) => Promise<void>;
  onClear: (key: string) => Promise<void>;
}

/** One settings row. Secrets show a masked preview; readOnly rows render value-only. */
export function SettingRow({ setting, onUpdate, onClear }: SettingRowProps) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const isOn = setting.type === 'boolean' && setting.hasValue && setting.value === '1';

  const handleSave = async () => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    try {
      await onUpdate(setting.key, draft.trim());
      setDraft('');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    setSaving(true);
    try {
      if (isOn) await onClear(setting.key);
      else await onUpdate(setting.key, '1');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onClear(setting.key);
    } finally {
      setSaving(false);
    }
  };

  const isBooleanToggle = !setting.readOnly && setting.type === 'boolean';

  return (
    <div className="flex flex-col gap-1.5 py-3.5 border-b border-border last:border-0">
      <div className="flex items-center gap-2">
        <span className="text-ui-lg font-medium">{setting.label}</span>
        {setting.source && (
          <Badge variant="outline" className="text-ui-xs font-mono px-1.5 py-0 h-[18px]">
            {setting.source}
          </Badge>
        )}
        {saving && <span className="text-ui-sm text-muted-foreground">saving…</span>}
        {isBooleanToggle && (
          <Switch
            checked={isOn}
            onCheckedChange={() => void handleToggle()}
            disabled={saving}
            aria-label={setting.label}
            className="ml-auto"
          />
        )}
      </div>
      <p className="text-ui text-muted-foreground leading-snug">{setting.description}</p>
      {!isBooleanToggle && (
        <div className="text-ui font-mono text-foreground/80 mt-0.5">
          {setting.hasValue ? setting.value : <span className="text-muted-foreground italic">Not set</span>}
        </div>
      )}
      {!setting.readOnly && setting.type !== 'boolean' && (
        <div className="flex items-center gap-2 mt-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Enter new value"
            className="h-8 text-ui font-mono"
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
          />
          <Button size="sm" onClick={handleSave} disabled={!draft.trim() || saving} className={cn('h-8')}>
            Save
          </Button>
          {setting.hasValue && (
            <Button size="sm" variant="ghost" onClick={handleClear} disabled={saving} className="h-8" aria-label="Clear">
              <Trash2 className="size-3.5" />
              <span>Clear</span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
