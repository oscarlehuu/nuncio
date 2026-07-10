import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchCrewProfiles,
  resolveCrewProfile,
  type CrewProfileDto,
  type ResolvedCrewProfileDto,
} from '@nuncio/core/crew-api';
import type { CrewExecutionMode } from './crew-composer';
import {
  crewResolutionKey,
  isCrewResolutionCurrent,
  shouldApplyCrewResolution,
} from './crew-composer';
import { fetchCrewProjects, type CrewProject } from './crew-projects';

export function useCrewComposerState(mode: CrewExecutionMode) {
  const [profiles, setProfiles] = useState<CrewProfileDto[]>([]);
  const [projects, setProjects] = useState<CrewProject[]>([]);
  const [profileId, setProfileId] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [resolution, setResolution] = useState<ResolvedCrewProfileDto | null>(null);
  const [resolvedFor, setResolvedFor] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolutionAttempt, setResolutionAttempt] = useState(0);
  const optionsLock = useRef(false);
  const resolutionRequestId = useRef(0);

  const loadOptions = useCallback(async () => {
    if (optionsLock.current) return;
    optionsLock.current = true;
    setOptionsLoading(true);
    setError(null);
    try {
      const [nextProfiles, nextProjects] = await Promise.all([
        fetchCrewProfiles(),
        fetchCrewProjects(),
      ]);
      setProfiles(nextProfiles);
      setProjects(nextProjects);
      setProfileId((current) =>
        nextProfiles.some((profile) => profile.id === current) ? current : nextProfiles[0]?.id ?? '',
      );
      setProjectPath((current) =>
        nextProjects.some((project) => project.path === current) ? current : nextProjects[0]?.path ?? '',
      );
      setLoaded(true);
    } catch {
      setError('Could not load Crew profiles or projects.');
    } finally {
      optionsLock.current = false;
      setOptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === 'crew' && !loaded) void loadOptions();
  }, [loadOptions, loaded, mode]);

  useEffect(() => {
    const current = ++resolutionRequestId.current;
    if (mode !== 'crew' || !profileId || !projectPath) {
      setResolution(null);
      setResolvedFor(null);
      setResolving(false);
      return;
    }
    const controller = new AbortController();
    const selectionKey = crewResolutionKey(profileId, projectPath);
    setResolvedFor(null);
    setResolving(true);
    setError(null);
    resolveCrewProfile(profileId, projectPath, controller.signal)
      .then((next) => {
        if (shouldApplyCrewResolution(current, resolutionRequestId.current, controller.signal.aborted)) {
          setResolution(next);
          setResolvedFor(selectionKey);
        }
      })
      .catch(() => {
        if (!shouldApplyCrewResolution(current, resolutionRequestId.current, controller.signal.aborted)) return;
        setResolution(null);
        setResolvedFor(null);
        setError('Could not resolve this Crew profile.');
      })
      .finally(() => {
        if (shouldApplyCrewResolution(current, resolutionRequestId.current, controller.signal.aborted)) {
          setResolving(false);
        }
      });
    return () => controller.abort();
  }, [mode, profileId, projectPath, resolutionAttempt]);

  const retry = useCallback(() => {
    setError(null);
    if (loaded) setResolutionAttempt((value) => value + 1);
    else void loadOptions();
  }, [loadOptions, loaded]);

  const resolutionIsCurrent =
    mode === 'crew' && isCrewResolutionCurrent(resolvedFor, profileId, projectPath);

  return {
    profiles,
    projects,
    profileId,
    projectPath,
    resolution: resolutionIsCurrent ? resolution : null,
    optionsLoading,
    resolving,
    error,
    setProfileId,
    setProjectPath,
    retry,
    canSubmit: Boolean(resolutionIsCurrent && resolution?.state === 'ready' && !resolving),
  };
}
