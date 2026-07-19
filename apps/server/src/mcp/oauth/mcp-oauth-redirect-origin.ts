import { BadRequestException } from '@nestjs/common';

export interface RequestLikeForOrigin {
  protocol?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Build the OAuth redirect origin from the inbound HTTP request only.
 * Never trust a client-supplied origin — that would let an authenticated
 * caller register an attacker redirect_uri for the MCP authorization code.
 */
export function redirectOriginFromRequest(req: RequestLikeForOrigin): string {
  const protoHeader = headerFirst(req.headers['x-forwarded-proto']);
  const hostHeader =
    headerFirst(req.headers['x-forwarded-host']) ?? headerFirst(req.headers.host);
  if (!hostHeader || /[\s/]/.test(hostHeader) || hostHeader.includes('@')) {
    throw new BadRequestException('cannot determine a safe request host for OAuth redirect');
  }
  const proto = (protoHeader ?? req.protocol ?? 'http').split(',')[0]?.trim() || 'http';
  if (proto !== 'http' && proto !== 'https') {
    throw new BadRequestException('unsupported request protocol for OAuth redirect');
  }
  return `${proto}://${hostHeader}`;
}

function headerFirst(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return value?.trim() || undefined;
}
