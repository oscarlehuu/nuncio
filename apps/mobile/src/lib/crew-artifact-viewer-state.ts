export interface CrewArtifactViewerState {
  text: string;
  nextOffset: number;
  eof: boolean;
  loading: boolean;
  error: string | null;
}

export const initialCrewArtifactViewerState: CrewArtifactViewerState = {
  text: '', nextOffset: 0, eof: false, loading: false, error: null,
};

export function startCrewArtifactPage(state: CrewArtifactViewerState): CrewArtifactViewerState {
  if (state.loading || state.eof) return state;
  return { ...state, loading: true, error: null };
}

export function appendCrewArtifactPage(
  state: CrewArtifactViewerState,
  range: { text: string; nextOffset: number; eof: boolean },
): CrewArtifactViewerState {
  return {
    text: `${state.text}${range.text}`,
    nextOffset: range.nextOffset,
    eof: range.eof,
    loading: false,
    error: null,
  };
}

export function failCrewArtifactPage(
  state: CrewArtifactViewerState,
  message: string,
): CrewArtifactViewerState {
  return { ...state, loading: false, error: message };
}
