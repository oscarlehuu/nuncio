/**
 * DI token for the optional zero-credential Mock provider. It is only bound in
 * `AgentsModule` when `NUNCIO_FORCE_MOCK=1`; `AgentRegistry` injects it with
 * `@Optional()` so a normal boot resolves it to `undefined` and the provider is
 * never registered or selectable.
 */
export const MOCK_AGENT_PROVIDER = Symbol('MOCK_AGENT_PROVIDER');
