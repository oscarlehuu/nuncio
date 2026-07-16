import { CrewValidationError } from './domain/crew-errors';
import {
  defaultCrewVerificationWorkspaceFactory,
  type CrewVerificationWorkspaceFactory,
} from './crew-verification-workspace';

// The default verification workspace strategy: an exact-head disposable Git snapshot.
export const DEFAULT_CREW_VERIFICATION_WORKSPACE = 'git-snapshot';

export interface CrewVerificationWorkspaceStrategy {
  readonly name: string;
  readonly factory: CrewVerificationWorkspaceFactory;
}

// Selects how the disposable exact-head verification workspace is prepared. A second strategy (for
// example one that materializes the head inside a container image) registers by adding a named
// factory; the verifier picks it by name from the resolved profile policy. The interface is the
// same `CrewVerificationWorkspaceFactory` already used today, so nothing downstream changes.
export class CrewVerificationWorkspaceRegistry {
  private readonly strategies = new Map<string, CrewVerificationWorkspaceFactory>();

  constructor(strategies: CrewVerificationWorkspaceStrategy[] = [
    { name: DEFAULT_CREW_VERIFICATION_WORKSPACE, factory: defaultCrewVerificationWorkspaceFactory },
  ]) {
    for (const strategy of strategies) this.register(strategy.name, strategy.factory);
  }

  // Last registration for a name wins, so a host may deliberately override the default strategy.
  register(name: string, factory: CrewVerificationWorkspaceFactory): void {
    const key = name?.trim();
    if (!key) {
      throw new CrewValidationError('Crew verification workspace strategy requires a non-empty name');
    }
    this.strategies.set(key, factory);
  }

  names(): string[] { return [...this.strategies.keys()]; }
  has(name: string): boolean { return this.strategies.has(name.trim()); }

  resolve(name?: string): CrewVerificationWorkspaceFactory {
    const key = name?.trim() || DEFAULT_CREW_VERIFICATION_WORKSPACE;
    const factory = this.strategies.get(key);
    if (!factory) {
      throw new CrewValidationError(`Unknown Crew verification workspace strategy: ${key}`);
    }
    return factory;
  }
}
