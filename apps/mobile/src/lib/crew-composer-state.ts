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
import {
  fetchCrewBranches,
  fetchCrewProjects,
  preferredCrewBaseBranch,
  selectableCrewBranches,
  type CrewBranch,
  type CrewProject,
} from './crew-projects';

export function useCrewComposerState(mode: CrewExecutionMode) {
  const [profiles, setProfiles] = useState<CrewProfileDto[]>([]);
  const [projects, setProjects] = useState<CrewProject[]>([]);
  const [profileId, setProfileId] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [branches, setBranches] = useState<CrewBranch[]>([]);
  const [baseBranch, setBaseBranch] = useState('');
  const [branchesForProject, setBranchesForProject] = useState<string | null>(null);
  const [resolution, setResolution] = useState<ResolvedCrewProfileDto | null>(null);
  const [resolvedFor, setResolvedFor] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolutionAttempt, setResolutionAttempt] = useState(0);
  const [branchAttempt, setBranchAttempt] = useState(0);
  const optionsLock = useRef(false);
  const branchRequestId = useRef(0);
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
    const current = ++branchRequestId.current;
    setBranchesForProject(null);
    setBranches([]);
    setBaseBranch('');
    if (mode !== 'crew' || !projectPath) {
      setBranchesLoading(false);
      return;
    }
    setBranchesLoading(true);
    setError(null);
    fetchCrewBranches(projectPath)
      .then((next) => {
        if (current !== branchRequestId.current) return;
        const selectable = selectableCrewBranches(next);
        const preferred = preferredCrewBaseBranch(selectable);
        setBranches(selectable);
        setBaseBranch(preferred);
        setBranchesForProject(projectPath);
        if (!preferred) setError('No selectable base branches found for this project.');
      })
      .catch(() => {
        if (current !== branchRequestId.current) return;
        setError('Could not load base branches for this project.');
      })
      .finally(() => {
        if (current === branchRequestId.current) setBranchesLoading(false);
      });
  }, [branchAttempt, mode, projectPath]);

  useEffect(() => {
    const current = ++resolutionRequestId.current;
    const branchReady = branchesForProject === projectPath && Boolean(baseBranch);
    if (mode !== 'crew' || !profileId || !projectPath || !branchReady) {
      setResolution(null);
      setResolvedFor(null);
      setResolving(false);
      return;
    }
    const controller = new AbortController();
    const selectionKey = crewResolutionKey(profileId, projectPath, baseBranch);
    setResolvedFor(null);
    setResolving(true);
    setError(null);
    resolveCrewProfile(profileId, projectPath, baseBranch, controller.signal)
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
  }, [baseBranch, branchesForProject, mode, profileId, projectPath, resolutionAttempt]);

  const retry = useCallback(() => {
    setError(null);
    if (loaded) {
      setBranchAttempt((value) => value + 1);
      setResolutionAttempt((value) => value + 1);
    }
    else void loadOptions();
  }, [loadOptions, loaded]);

  const resolutionIsCurrent =
    mode === 'crew'
    && branchesForProject === projectPath
    && isCrewResolutionCurrent(resolvedFor, profileId, projectPath, baseBranch);

  return {
    profiles,
    projects,
    branches,
    profileId,
    projectPath,
    baseBranch,
    resolution: resolutionIsCurrent ? resolution : null,
    optionsLoading: optionsLoading || branchesLoading,
    resolving,
    error,
    setProfileId,
    setProjectPath,
    setBaseBranch,
    retry,
    canSubmit: Boolean(
      resolutionIsCurrent && resolution?.state === 'ready'
      && !resolving && !branchesLoading,
    ),
  };
}
