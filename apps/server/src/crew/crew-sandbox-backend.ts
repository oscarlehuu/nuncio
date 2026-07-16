import { CrewValidationError } from './domain/crew-errors';
import {
  buildCrewSandboxLaunch,
  isCrewVerifierSandboxAvailable,
  type CrewSandboxLaunch,
  type CrewSandboxOptions,
} from './crew-command-sandbox';

// The default sandbox backend. It confines the verify command with Seatbelt on macOS or
// bubblewrap on Linux, selected by platform inside `buildCrewSandboxLaunch`.
export const DEFAULT_CREW_SANDBOX_BACKEND = 'host';

// A pluggable confinement strategy for the deterministic verify command. A second backend (for
// example a container-based one) registers by implementing this and adding itself to the registry;
// the runner then selects it by name from the resolved profile policy. No reducer or authority
// change is involved — the backend only decides how a single command is confined.
export interface CrewSandboxBackend {
  readonly name: string;
  isAvailable(): boolean;
  build(command: string, cwd: string, options?: CrewSandboxOptions): CrewSandboxLaunch;
}

export const hostCrewSandboxBackend: CrewSandboxBackend = {
  name: DEFAULT_CREW_SANDBOX_BACKEND,
  isAvailable: () => isCrewVerifierSandboxAvailable(),
  build: (command, cwd, options = {}) =>
    buildCrewSandboxLaunch(command, cwd, process.platform, undefined, options),
};

export class CrewSandboxBackendRegistry {
  private readonly backends = new Map<string, CrewSandboxBackend>();

  constructor(backends: CrewSandboxBackend[] = [hostCrewSandboxBackend]) {
    for (const backend of backends) this.register(backend);
  }

  // Last registration for a name wins, so a host may deliberately override the default backend.
  register(backend: CrewSandboxBackend): void {
    const name = backend?.name?.trim();
    if (!name) throw new CrewValidationError('Crew sandbox backend requires a non-empty name');
    this.backends.set(name, backend);
  }

  names(): string[] { return [...this.backends.keys()]; }
  has(name: string): boolean { return this.backends.has(name.trim()); }

  resolve(name?: string): CrewSandboxBackend {
    const key = name?.trim() || DEFAULT_CREW_SANDBOX_BACKEND;
    const backend = this.backends.get(key);
    if (!backend) throw new CrewValidationError(`Unknown Crew sandbox backend: ${key}`);
    return backend;
  }
}
