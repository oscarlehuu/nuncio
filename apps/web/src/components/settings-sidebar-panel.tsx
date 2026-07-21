import { ArrowLeft, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SETTINGS_SECTION_NAV_ITEMS,
  type SettingsSectionId,
} from '../lib/settings-sections';
import { SettingsSectionNav } from './settings-section-nav';

interface SettingsSidebarPanelProps {
  activeSection: SettingsSectionId;
  searchQuery: string;
  onSectionChange: (section: SettingsSectionId) => void;
  onSearchChange: (query: string) => void;
  onBack: () => void;
}

/**
 * Cursor-style settings left rail: Back → search → section list.
 * Mounted in the main app sidebar when the route is `/settings`.
 */
export function SettingsSidebarPanel({
  activeSection,
  searchQuery,
  onSectionChange,
  onSearchChange,
  onBack,
}: SettingsSidebarPanelProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 p-3 pb-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 text-ui-lg text-muted-foreground hover:text-foreground"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            role="searchbox"
            aria-label="Search settings"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search Settings"
            className="h-8 pl-8 text-ui"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        <SettingsSectionNav
          variant="sidebar"
          items={SETTINGS_SECTION_NAV_ITEMS}
          activeId={activeSection}
          onSelect={(id) => onSectionChange(id as SettingsSectionId)}
        />
      </div>
    </div>
  );
}
