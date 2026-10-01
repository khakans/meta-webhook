import { BadRequestException, Injectable } from '@nestjs/common';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from './config.js';

function isPrivateIpv4(address: string) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value)))
    return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIp(address: string) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:'))
    return isPrivateIpv4(normalized.slice(7));
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized)
  );
}

@Injectable()
export class UrlPolicyService {
  async assertSafe(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Destination URL is invalid');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new BadRequestException(
        'Destination must be an HTTP/HTTPS URL without credentials',
      );
    }
    if (url.protocol === 'http:' && !config.allowHttpDestinations()) {
      throw new BadRequestException('HTTP destinations are disabled');
    }

    const hostname = url.hostname.toLowerCase();
    if (config.destinationHostAllowlist().has(hostname)) return url;
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new BadRequestException('Private destination host is not allowed');
    }
    if (isIP(hostname)) {
      if (isPrivateIp(hostname))
        throw new BadRequestException('Private destination IP is not allowed');
      return url;
    }

    let addresses: LookupAddress[];
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new BadRequestException('Destination hostname cannot be resolved');
    }
    if (
      !addresses.length ||
      addresses.some(({ address }) => isPrivateIp(address))
    ) {
      throw new BadRequestException(
        'Destination resolves to a private or reserved address',
      );
    }
    return url;
  }
}
