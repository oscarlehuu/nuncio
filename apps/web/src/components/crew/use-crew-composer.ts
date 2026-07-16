import { useEffect, useRef, useState } from 'react';
import {
  createCrewTask,
  fetchCrewProfiles,
  resolveCrewProfile,
  type CrewProfileDto,
  type ResolvedCrewProfileDto,
} from '@nuncio/core/crew-api';
import type { ExecutionMode } from './execution-mode-picker';

export function useCrewComposer({
  projectPath,
  baseBranch,
  remoteBase = '',
  onCreated,
}: {
  projectPath?: string;
  baseBranch?: string;
  /**
   * Origin-absolute API base of the machine that will OWN this run. Empty = the
   * machine this page already talks to (local). When set, profiles list, resolve,
   * and create all target that machine — authority never leaves it.
   */
  remoteBase?: string;
  onCreated?: (taskId: string) => void;
}) {
  const [mode, setModeState] = useState<ExecutionMode>('solo');
  const [profiles, setProfiles] = useState<CrewProfileDto[]>([]);
  const [profileId, setProfileId] = useState('');
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [resolution, setResolution] = useState<ResolvedCrewProfileDto | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const requestId = useRef(0);
  const submitLock = useRef(false);

  useEffect(() => {
    if (mode !== 'crew') return;
    let cancelled = false;
    // Switching the target machine re-lists profiles from that machine's own
    // catalog, so hold the loading state until the new list arrives.
    setLoadingProfiles(true);
    setError(null);
    fetchCrewProfiles(remoteBase)
      .then((next) => {
        if (cancelled) return;
        setProfiles(next);
        setProfileId((current) => next.some((profile) => profile.id === current)
          ? current
          : next[0]?.id || '');
        setProfileRefresh((value) => value + 1);
      })
      .catch((cause) => {
        if (cancelled) return;
        setProfiles([]);
        setProfileId('');
        setResolution(null);
        setError(cause instanceof Error ? cause.message : 'Failed to load Crew profiles');
      })
      .finally(() => { if (!cancelled) setLoadingProfiles(false); });
    return () => { cancelled = true; };
  }, [mode, remoteBase]);

  useEffect(() => {
    if (mode !== 'crew' || loadingProfiles || !profileId || !projectPath) {
      setResolution(null);
      setResolving(false);
      return;
    }
    const controller = new AbortController();
    const current = ++requestId.current;
    setResolving(true);
    setError(null);
    resolveCrewProfile(profileId, projectPath, baseBranch, controller.signal, remoteBase)
      .then((next) => {
        if (current === requestId.current) setResolution(next);
      })
      .catch((cause) => {
        if (controller.signal.aborted || current !== requestId.current) return;
        setResolution(null);
        setError(cause instanceof Error ? cause.message : 'Failed to resolve Crew profile');
      })
      .finally(() => {
        if (current === requestId.current) setResolving(false);
      });
    return () => controller.abort();
  }, [baseBranch, loadingProfiles, mode, profileId, profileRefresh, projectPath, remoteBase]);

  const setMode = (next: ExecutionMode) => {
    if (next === 'crew' && mode !== 'crew') {
      setLoadingProfiles(true);
      setResolution(null);
    }
    setModeState(next);
  };

  const submit = async (objective: string) => {
    if (submitLock.current || !projectPath || !profileId || resolution?.state !== 'ready') return;
    submitLock.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const { task } = await createCrewTask({ objective, projectPath, baseBranch, profileId }, remoteBase);
      onCreated?.(task.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to create Crew task');
      throw cause;
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  return {
    mode, setMode, profiles, profileId, setProfileId, resolution, loadingProfiles, resolving, error, submitting, submit,
    canSubmit: Boolean(projectPath && profileId && resolution?.state === 'ready' && !loadingProfiles && !resolving && !submitting),
  };
}
