export interface TailscaleSelfDto {
  hostName: string;
  dnsName: string;
  ips: string[];
  os: string;
  loginName: string | null;
}

export interface TailscalePeerDto {
  hostName: string;
  dnsName: string;
  ips: string[];
  os: string;
  online: boolean;
  loginName: string | null;
  /** True when the peer belongs to the same Tailscale account as this server. */
  sameUser: boolean;
}

export interface TailscaleStatusDto {
  /** Tailscale CLI found and responding. */
  installed: boolean;
  /** tailscaled backend state is Running (logged in, connected). */
  running: boolean;
  /** Effective value of the auto-trust setting. */
  autoTrust: boolean;
  tailnet: string | null;
  self: TailscaleSelfDto | null;
  peers: TailscalePeerDto[];
}
