export const CAPTURE_EVIDENCE_TOOL_NAME = 'capture_evidence';

/**
 * Engine tool over the provider-neutral evidence capture service (doc layer 2):
 * the agent drives the app to an interesting state with its own skills, then
 * calls this tool; the HARNESS captures deterministically (viewport, HEAD
 * binding, MediaStore) and the transcript gets the proof. The tool only
 * validates and delegates — capture policy stays in the injected callback.
 */

export type CaptureEvidencePhase = 'before' | 'after';

export interface CaptureEvidenceInput {
  url?: string;
  route?: string;
  phase: CaptureEvidencePhase;
}

export type CaptureEvidenceResult =
  | { ok: true; route: string; workspaceHead: string }
  | { ok: false; reason: string };

export interface CaptureEvidenceToolDeps {
  capture(input: CaptureEvidenceInput): Promise<CaptureEvidenceResult>;
}

export function normalizeCaptureEvidenceInput(
  input: unknown,
): { value: CaptureEvidenceInput } | { error: string } {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'capture_evidence takes an object with optional url/route/phase.' };
  }

  const phase = raw.phase ?? 'after';
  if (phase !== 'before' && phase !== 'after') {
    return { error: 'capture_evidence phase must be "before" or "after".' };
  }

  let url: string | undefined;
  if (raw.url !== undefined) {
    if (typeof raw.url !== 'string' || !/^https?:\/\//i.test(raw.url.trim())) {
      return { error: 'capture_evidence url must be an http(s) URL.' };
    }
    url = raw.url.trim();
  }

  const route = typeof raw.route === 'string' && raw.route.trim() ? raw.route.trim() : undefined;

  return {
    value: {
      ...(url ? { url } : {}),
      ...(route ? { route } : {}),
      phase,
    },
  };
}

const PARAMETERS = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description:
        'The http(s) page to witness (e.g. the dev server route you just changed). Omit to re-capture the last target this session witnessed.',
    },
    route: {
      type: 'string',
      description: 'Optional short label for the route (shown with the screenshot).',
    },
    phase: {
      type: 'string',
      enum: ['before', 'after'],
      description:
        '"before" = baseline prior to your change, "after" = proof once done. Defaults to after.',
    },
  },
};

const DESCRIPTION =
  'Capture deterministic screenshot evidence of the running app. Drive the page to the state you want witnessed first (the harness screenshots the URL as-is, bound to the current git HEAD), then call this tool. ' +
  'Use phase "before" for a baseline at task start and "after" as proof when a UI-touching change is done.';

/** Acknowledge-and-delegate: capture mechanics live behind the injected callback. */
export function buildCaptureEvidenceTool(
  deps: CaptureEvidenceToolDeps,
  defineTool?: (tool: unknown) => unknown,
): unknown {
  const wrap = defineTool ?? ((tool: unknown) => tool);
  return wrap({
    name: CAPTURE_EVIDENCE_TOOL_NAME,
    label: 'Capture evidence',
    description: DESCRIPTION,
    promptSnippet:
      'capture_evidence: harness-captured before/after screenshots of the app, bound to the current HEAD. Capture "after" proof when a UI change is done.',
    promptGuidelines: [
      'Capture a "before" baseline at the start of a UI-touching task when practical.',
      'Capture "after" evidence once the change is verified, from the route it affects.',
      'The harness screenshots the URL exactly as it renders — make sure the dev server is running first.',
    ],
    parameters: PARAMETERS,
    execute: async (_toolCallId: string, params: unknown) => {
      const normalized = normalizeCaptureEvidenceInput(params);
      if ('error' in normalized) {
        return {
          content: [{ type: 'text', text: `capture_evidence ignored: ${normalized.error}` }],
          isError: true,
          details: {},
        };
      }
      const result = await deps.capture(normalized.value);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: `capture_evidence failed: ${result.reason}` }],
          isError: true,
          details: {},
        };
      }
      return {
        content: [
          {
            type: 'text',
            text:
              `Captured ${normalized.value.phase} evidence of ${result.route} ` +
              `(workspace HEAD ${result.workspaceHead}). It is attached to the session transcript.`,
          },
        ],
        details: {},
      };
    },
  });
}
