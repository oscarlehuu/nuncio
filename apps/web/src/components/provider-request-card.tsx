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

export function ProviderRequestCard({
  request,
  onRespond,
  responding,
}: ProviderRequestCardProps) {
  const pending = request.status === 'pending';
  const detail = requestDetail(request.params);
  const label = request.provider === 'codex' ? 'Codex action' : `${request.provider} action`;

  return (
    <div className="flex items-start justify-start">
      <div className="max-w-[92%] rounded-[10px] border border-border bg-card px-3.5 py-3 text-sm shadow-sm">
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
        <div className="text-xs text-muted-foreground">{request.method}</div>
        {detail ? (
          <code className="mt-2 block overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs text-foreground">
            {detail}
          </code>
        ) : null}
        {pending ? (
          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void onRespond?.(request.requestId, 'approve')}
              disabled={!onRespond || responding}
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
              disabled={!onRespond || responding}
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

function requestDetail(params: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return params === undefined ? '' : String(params);
  }

  const record = params as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'path']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key];
  }

  try {
    return JSON.stringify(params, null, 2);
  } catch {
    return '';
  }
}
