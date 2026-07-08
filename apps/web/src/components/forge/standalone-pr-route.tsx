import { useNavigate, useSearchParams } from 'react-router-dom';
import { PrDetail } from './pr-detail';

export function StandalonePrRoute() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const path = params.get('path')?.trim() ?? '';
  const numberRaw = params.get('number') ?? '';
  const number = /^\d+$/.test(numberRaw) ? Number(numberRaw) : null;

  return (
    <section className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
      {path && number !== null ? (
        <PrDetail path={path} number={number} onBack={() => navigate(-1)} headerVariant="page" />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto w-full max-w-[920px]">
            <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              Pull request link is missing repo context.
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
