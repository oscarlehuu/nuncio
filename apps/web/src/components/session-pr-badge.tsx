import type { MouseEvent } from 'react';
import { GitMerge, GitPullRequest } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SessionPrBadge } from '../lib/session-pr-status';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

interface SessionPrBadgeButtonProps {
  badge: SessionPrBadge;
  className?: string;
}

export function SessionPrBadgeButton({ badge, className }: SessionPrBadgeButtonProps) {
  const Icon = badge.state === 'merged' ? GitMerge : GitPullRequest;

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    if (!badge.url) return;
    window.open(badge.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={badge.ariaLabel}
            title={badge.ariaLabel}
            disabled={!badge.url}
            onClick={onClick}
            className={cn(
              'inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring',
              badge.colorClass,
              badge.url ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
              className,
            )}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{badge.ariaLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
