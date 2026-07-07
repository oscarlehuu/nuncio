import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import type { ModelProvider } from '../lib/model-providers';
import { AutopilotView } from './autopilot-view';
import { LoopDetailView } from './loop-detail-view';
import { LoopRunDetailView } from './loop-run-detail-view';
import { GlobalRunsView } from './global-runs-view';

/**
 * The Autopilot route tree, lazy-loaded as one chunk from App so the detail/runs
 * surfaces never weigh on the entry bundle. Relative paths sit under `/autopilot`.
 */
export default function AutopilotRoutes({ providers }: { providers: ModelProvider[] }) {
  const navigate = useNavigate();
  return (
    <Routes>
      <Route index element={<AutopilotView onBack={() => navigate('/')} />} />
      <Route path="runs" element={<GlobalRunsView />} />
      <Route path=":loopId" element={<LoopDetailView providers={providers} />} />
      <Route path=":loopId/runs/:runId" element={<LoopRunDetailView />} />
      <Route path="*" element={<Navigate to="/autopilot" replace />} />
    </Routes>
  );
}
