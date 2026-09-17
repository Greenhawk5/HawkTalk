export function isBlockedUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }

  if (parsed.protocol !== 'https:') return true;

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === '' || hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === 'metadata.google.internal' || hostname.startsWith('169.254.')) return true;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return isBlockedIPv4(hostname);
  }

  // Node's URL.hostname preserves brackets for IPv6: [::1], [fe80::1]
  const ipv6 = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname.includes(':') ? hostname : null;
  if (ipv6 !== null) {
    return isBlockedIPv6(ipv6);
  }

  return false;
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1' || lower === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fe80:')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('ff')) return true;

  const ipv4Match = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match?.[1]) return isBlockedIPv4(ipv4Match[1]);

  return false;
}

export async function resolveAndCheck(url: string): Promise<boolean> {
  if (isBlockedUrl(url)) return false;
  return true;
}
