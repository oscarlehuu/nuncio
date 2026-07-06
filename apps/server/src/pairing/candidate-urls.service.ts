import { Injectable } from '@nestjs/common';
import { networkInterfaces } from 'node:os';

export interface CandidateUrls {
  urls: string[];
  hints: string[];
}

/**
 * Builds the reachable URLs a phone should try, in priority order. Phase 1 only
 * enumerates LAN IPv4 addresses; MagicDNS / Funnel candidates and degraded-mode
 * hints grow here in later work, which is why hints is already part of the shape.
 */
@Injectable()
export class CandidateUrlsService {
  build(): CandidateUrls {
    const port = Number(process.env.PORT ?? 3000);
    const urls: string[] = [];
    for (const address of lanIpv4Addresses()) {
      urls.push(`http://${address}:${port}`);
    }
    return { urls, hints: [] };
  }
}

function isIpv4(family: string | number): boolean {
  // Node <18 reports the string 'IPv4'; Node >=18 reports the number 4.
  return family === 'IPv4' || family === 4;
}

/** LAN IPv4s only: drop loopback/internal, link-local (169.254/16) and CGNAT/tailnet (100.64/10). */
function lanIpv4Addresses(): string[] {
  const found: string[] = [];
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.internal || !isIpv4(entry.family)) {
        continue;
      }
      if (entry.address.startsWith('169.254.') || isCarrierGradeNat(entry.address)) {
        continue;
      }
      found.push(entry.address);
    }
  }
  return found;
}

/** 100.64.0.0/10 — CGNAT range Tailscale draws from; not a LAN address a phone should dial directly. */
function isCarrierGradeNat(address: string): boolean {
  const octets = address.split('.');
  if (octets.length !== 4 || octets[0] !== '100') {
    return false;
  }
  const second = Number(octets[1]);
  return Number.isInteger(second) && second >= 64 && second <= 127;
}
