import { isAbsolute, join } from 'node:path';
import type { SettingsService } from '../../settings/settings.service';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');

const DEFAULT_NUNCIO_MODELS_FILE = 'nuncio-models.json';
const warnedModelsPaths = new Set<string>();

function resolveModelsPath(agentDir: string, configuredPath?: string): string {
  const value = configuredPath?.trim();
  if (!value) return join(agentDir, DEFAULT_NUNCIO_MODELS_FILE);
  if (value === '~' || value.startsWith('~/') || isAbsolute(value)) return value;
  return join(agentDir, value);
}

/** Build Nuncio's Pi registry without loading the interactive Pi CLI models.json. */
export function createPiEngineModelRegistry(
  pi: PiSdk,
  agentDir: string,
  settings: Pick<SettingsService, 'resolve'>,
) {
  const authStorage = pi.AuthStorage.create(join(agentDir, 'auth.json'));
  const modelsPath = resolveModelsPath(
    agentDir,
    settings.resolve('NUNCIO_PI_MODELS_PATH'),
  );
  const modelRegistry = pi.ModelRegistry.create(authStorage, modelsPath);
  const loadError = modelRegistry.getError();
  if (loadError && !warnedModelsPaths.has(modelsPath)) {
    warnedModelsPaths.add(modelsPath);
    console.warn(
      `[pi-engine] Could not load custom models from ${modelsPath}; using built-in models only.`,
    );
  }

  return { authStorage, modelRegistry };
}
