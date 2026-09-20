import { AdminError } from './errors.ts';

export function validateProviderId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) {
    throw new AdminError('validation_failed', 'Invalid provider id');
  }
}

export function validateBaseUrl(url: unknown): asserts url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 512) {
    throw new AdminError('validation_failed', 'Invalid base URL');
  }
  if (!url.startsWith('https://')) {
    throw new AdminError('validation_failed', 'Base URL must use https');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AdminError('validation_failed', 'Invalid base URL format');
  }
  // Embedding credentials in the URL is never legitimate for a provider API.
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new AdminError('validation_failed', 'Base URL must not contain credentials');
  }
  const hostname = parsed.hostname.toLowerCase();
  // Block private/local address forms. Deterministic and bounded: literal
  // hostnames are classified textually; no DNS resolution is attempted (the
  // runtime cannot safely resolve DNS inside validation).
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new AdminError('validation_failed', 'Base URL must not target private networks');
  }
  // WHATWG URL keeps brackets on IPv6 literals (e.g. "[::1]"); strip them.
  const bareHost = hostname.replace(/^\[(.+)\]$/, '$1');
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bareHost);
  if (ipv4 !== null) {
    const octets = [
      Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4]),
    ] as const;
    if (octets.some((n) => n > 255)) throw new AdminError('validation_failed', 'Invalid base URL format');
    if (isPrivateIPv4(octets)) throw new AdminError('validation_failed', 'Base URL must not target private networks');
  } else if (bareHost.includes(':')) {
    if (isPrivateIPv6(bareHost)) throw new AdminError('validation_failed', 'Base URL must not target private networks');
  }
}

/** RFC1918/CGNAT/link-local/metadata/unspecified IPv4 ranges. */
function isPrivateIPv4(octets: readonly number[]): boolean {
  const [a, b] = [octets[0] as number, octets[1] as number];
  return a === 0 || a === 10 || a === 127 || // this-network, private, loopback
    (a === 169 && b === 254) || // link-local / cloud metadata (169.254.0.0/16)
    (a === 172 && b >= 16 && b <= 31) || // private (172.16.0.0/12)
    (a === 192 && b === 168) || // private (192.168.0.0/16)
    (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT (100.64.0.0/10)
}

/**
 * IPv6 forms that must never be targeted: unspecified (::), loopback (::1),
 * ULA fc00::/7, link-local fe80::/10, and IPv4-mapped ::ffff:<ipv4> addresses
 * (validated with the IPv4 rules to defeat mapped-address bypasses).
 * The input is the URL hostname with brackets already stripped.
 */
function isPrivateIPv6(hostname: string): boolean {
  // WHATWG serializes IPv4-mapped addresses in hex (e.g. "[::ffff:10.0.0.1]"
  // becomes "::ffff:a00:1"), so handle both dotted-quad and hex remainders by
  // decoding the embedded 32-bit IPv4 address.
  if (hostname.startsWith('::ffff:')) {
    const remainder = hostname.slice('::ffff:'.length);
    if (remainder.includes('.')) {
      const parts = remainder.split('.').map(Number) as unknown as number[];
      return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && isPrivateIPv4(parts);
    }
    const groups = remainder.split(':').filter((g) => g.length > 0);
    if (groups.length === 2) {
      const hex32 = (groups[0] ?? '').padStart(4, '0') + (groups[1] ?? '').padStart(4, '0');
      if (/^[0-9a-f]{8}$/.test(hex32)) {
        const octets = [
          parseInt(hex32.slice(0, 2), 16),
          parseInt(hex32.slice(2, 4), 16),
          parseInt(hex32.slice(4, 6), 16),
          parseInt(hex32.slice(6, 8), 16),
        ];
        return isPrivateIPv4(octets);
      }
    }
    return false;
  }
  if (hostname === '::' || hostname === '::1') return true;
  const firstHextet = /^([0-9a-f]{1,4})/.exec(hostname);
  if (firstHextet !== null && firstHextet[1] !== undefined) {
    const value = parseInt(firstHextet[1], 16);
    if ((value >= 0xfc00 && value <= 0xfdff) || (value >= 0xfe80 && value <= 0xfebf)) return true;
  }
  return false;
}

export function validateDefaultModel(model: unknown): asserts model is string {
  if (typeof model !== 'string' || model.length === 0 || model.length > 128) {
    throw new AdminError('validation_failed', 'Invalid default model');
  }
  // Colons ARE allowed: OpenRouter model ids legitimately contain them
  // (e.g. "thinkingmachines/inkling:free"). The AI Router (src/ai/router.ts
  // resolveTarget) splits model references on the FIRST colon only, so
  // "openrouter:thinkingmachines/inkling:free" resolves provider="openrouter"
  // and model="thinkingmachines/inkling:free".
}

export function validateWeight(weight: unknown): asserts weight is number {
  if (!Number.isSafeInteger(weight) || (weight as number) < 1 || (weight as number) > 10000) {
    throw new AdminError('validation_failed', 'Weight must be an integer between 1 and 10000');
  }
}

export function validateTimeoutMs(ms: unknown): asserts ms is number {
  if (!Number.isSafeInteger(ms) || (ms as number) < 1000 || (ms as number) > 120000) {
    throw new AdminError('validation_failed', 'Timeout must be between 1000 and 120000 ms');
  }
}

export function validateMaxCredentialAttempts(n: unknown): asserts n is number {
  if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 10) {
    throw new AdminError('validation_failed', 'Max credential attempts must be between 1 and 10');
  }
}

export function validateCredentialLabel(label: unknown): asserts label is string {
  if (typeof label !== 'string' || label.length === 0 || label.length > 128) {
    throw new AdminError('validation_failed', 'Invalid credential label');
  }
  if (!/^[\x20-\x7E]+$/.test(label)) {
    throw new AdminError('validation_failed', 'Credential label must be printable ASCII');
  }
}

export function validateCredentialWeight(weight: unknown): asserts weight is number {
  if (!Number.isSafeInteger(weight) || (weight as number) < 1 || (weight as number) > 10000) {
    throw new AdminError('validation_failed', 'Credential weight must be an integer between 1 and 10000');
  }
}
