import { Check, ShieldQuestion, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ProviderRequestDecision } from '../lib/api';

export interface ProviderRequestView {
  kind: 'provider_request';
  requestId: string;
  provider: string;
  method: string;
  params?: unknown;
  status: 'pending' | 'resolved';
  decision?: ProviderRequestDecision;
}

interface ProviderRequestCardProps {
  request: ProviderRequestView;
  onRespond?: (requestId: string, decision: ProviderRequestDecision) => void | Promise<void>;
  responding?: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  cursor: 'Cursor',
  pi: 'Nuncio Engine',
  devin: 'Devin',
};

export function ProviderRequestCard({
  request,
  onRespond,
  responding,
}: ProviderRequestCardProps) {
  const pending = request.status === 'pending';
  const detail = requestDetail(request.params);
  const providerLabel =
    PROVIDER_LABELS[request.provider] ??
    (request.provider ? request.provider.charAt(0).toUpperCase() + request.provider.slice(1) : 'Provider');
  const label = `${providerLabel} action`;

  return (
    <div className="flex items-start justify-start">
      <div className="max-w-[92%] rounded-[10px] border border-border bg-card px-3.5 py-3 text-sm shadow-e1 surface-lit">
        <div className="mb-2 flex items-center gap-2">
          <ShieldQuestion className="size-4 text-primary" />
          <span className="font-medium">{label}</span>
          {pending ? (
            <Badge variant="outline">Pending</Badge>
          ) : (
            <Badge variant="secondary">
              {request.decision === 'approve' ? 'Approved' : 'Denied'}
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground">{methodLabel(request.method)}</div>
        {detail ? (
          <code className="mt-2 block overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs text-foreground">
            {detail}
          </code>
        ) : null}
        {pending && onRespond ? (
          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void onRespond?.(request.requestId, 'approve')}
              disabled={responding}
              aria-label="Approve request"
              className="gap-1.5"
            >
              <Check className="size-3.5" />
              Approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void onRespond?.(request.requestId, 'deny')}
              disabled={responding}
              aria-label="Deny request"
              className="gap-1.5"
            >
              <X className="size-3.5" />
              Deny
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function methodLabel(method: string): string {
  if (method === 'session/request_permission') return 'Permission request';
  return method;
}

/** Prefer a short human summary over dumping ACP option lists as JSON. */
export function requestDetail(params: unknown): string {
  if (params === undefined || params === null) return '';
  if (typeof params !== 'object' || Array.isArray(params)) return String(params);

  const record = params as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'path', 'prompt']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key];
  }
  if (typeof record.toolName === 'string' && record.toolName.trim()) {
    return record.toolName;
  }

  const toolCall = record.toolCall;
  if (toolCall && typeof toolCall === 'object' && !Array.isArray(toolCall)) {
    const call = toolCall as Record<string, unknown>;
    if (typeof call.title === 'string' && call.title.trim()) return call.title.trim();
    const raw = call.rawInput;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const input = raw as Record<string, unknown>;
      for (const key of ['command', 'cmd', 'path', 'summary']) {
        if (typeof input[key] === 'string' && input[key].trim()) return input[key];
      }
    }
  }

  // ACP permission options: prefer a descriptive allow_* label over bare "Allow".
  if (Array.isArray(record.options)) {
    const allowNames = record.options.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const recordItem = item as { kind?: unknown; name?: unknown };
      if (typeof recordItem.kind !== 'string' || !recordItem.kind.startsWith('allow')) return [];
      if (typeof recordItem.name !== 'string' || !recordItem.name.trim()) return [];
      return [recordItem.name.trim()];
    });
    const descriptive = allowNames.find((name) => {
      const lower = name.toLowerCase();
      return lower !== 'allow' && lower !== 'allow once';
    });
    if (descriptive) return descriptive;
    if (allowNames[0]) return allowNames[0];
  }

  try {
    return JSON.stringify(params, null, 2);
  } catch {
    return '';
  }
}
