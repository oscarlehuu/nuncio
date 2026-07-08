import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../ui/button';
import { PrDetail } from './pr-detail';

export function StandalonePrRoute() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const path = params.get('path')?.trim() ?? '';
  const numberRaw = params.get('number') ?? '';
  const number = /^\d+$/.test(numberRaw) ? Number(numberRaw) : null;

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      <header className="flex items-center gap-2 border-b border-border bg-background/80 px-4 py-3 pl-16 backdrop-blur md:pl-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">Pull request</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto w-full max-w-[920px]">
          {path && number !== null ? (
            <PrDetail path={path} number={number} onBack={() => navigate(-1)} />
          ) : (
            <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              Pull request link is missing repo context.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
