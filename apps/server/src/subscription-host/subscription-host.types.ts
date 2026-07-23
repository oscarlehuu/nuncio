/** How Nuncio relates to the subscription model host process pair. */
export type SubscriptionHostMode = 'managed' | 'external';

/** One model exposed by the router's OpenAI-compatible `/v1/models` feed. */
export interface SubscriptionHostModel {
  id: string;
  displayName: string;
  ownedBy?: string;
  /** Transport family the router speaks for this model (`anthropic-messages`, OpenAI-family, …). */
  api?: string;
}

export interface SubscriptionHostStatusDto {
  enabled: boolean;
  /** Router health-check succeeded and returned a model list. */
  online: boolean;
  mode: SubscriptionHostMode;
  /** Pinned package version Nuncio installs/runs (never the package name). */
  version: string;
  /** Version actually installed under the data dir, if resolved. */
  installedVersion: string | null;
  /** Router loopback base URL (models + routing endpoint). */
  baseUrl: string;
  brokerPort: number;
  routerPort: number;
  managed: {
    running: boolean;
    brokerPid: number | null;
    routerPid: number | null;
  };
  modelCount: number;
  error: string | null;
}
