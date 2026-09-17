// Credential cryptography (Phase 4).
// Authenticated encryption for AI API keys at rest in D1 using only Web
// Crypto primitives available in Cloudflare Workers (and workerd tests).
//
// Design:
// - Master secret: dedicated Worker secret (CREDENTIALS_MASTER_SECRET),
//   supplied by the application layer. NEVER hard-coded, never logged.
// - Key derivation: PBKDF2-SHA-256, per-credential random 16-byte salt,
//   100_000 iterations → AES-GCM-256 key. A per-credential salt means two
//   identical keys seal differently and rotation never reuses parameters.
// - Encryption: AES-GCM with a random 12-byte IV per seal operation.
//   Tampering or a wrong master secret fails authentication (no partial data).
// - Encoding: `v1.<salt-b64url>.<iv-b64url>.<ciphertext-b64url>`. The version
//   prefix allows future algorithm migration without silent misreads.
//
// Plaintext discipline: seal/unseal keep plaintext in local strings only for
// the duration of the call; nothing is logged, cached, or embedded in errors.

const VERSION = 'v1';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 100_000;

function bytesToB64Url(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

async function deriveKey(masterSecret: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(masterSecret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypts a plaintext credential. Returns the versioned sealed envelope. */
export async function sealCredential(plaintext: string, masterSecret: string): Promise<string> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new Error('Cannot seal an empty credential');
  if (typeof masterSecret !== 'string' || masterSecret.length === 0) throw new Error('Credential master secret is not configured');
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(masterSecret, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext)),
  );
  return `${VERSION}.${bytesToB64Url(salt)}.${bytesToB64Url(iv)}.${bytesToB64Url(ciphertext)}`;
}

/**
 * Decrypts a sealed envelope. Throws a generic error on wrong secrets,
 * tampering, or malformed envelopes — never any key material.
 */
export async function unsealCredential(sealed: string, masterSecret: string): Promise<string> {
  if (typeof masterSecret !== 'string' || masterSecret.length === 0) throw new Error('Credential master secret is not configured');
  const parts = typeof sealed === 'string' ? sealed.split('.') : [];
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Credential envelope is invalid');
  const [, saltB64, ivB64, ctB64] = parts as [string, string, string, string];
  let salt: Uint8Array;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    salt = b64UrlToBytes(saltB64);
    iv = b64UrlToBytes(ivB64);
    ciphertext = b64UrlToBytes(ctB64);
  } catch {
    throw new Error('Credential envelope is invalid');
  }
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ciphertext.length === 0) {
    throw new Error('Credential envelope is invalid');
  }
  try {
    const key = await deriveKey(masterSecret, salt);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('Credential decryption failed');
  }
}
