#!/usr/bin/env node
// HawkTalk secure provisioning CLI.
//
// Provisions AI providers and credentials without ever sending a plaintext
// API key through Telegram chat history, command-line arguments, logs, or the
// Worker runtime. The key is read from stdin only:
//   - interactive terminal: hidden raw-mode read (masked with '*'),
//   - non-TTY: piped stdin (never echoed, never logged).
//
// The key is sealed with the SAME production crypto as the Worker
// (src/ai/crypto.ts sealCredential â€” AES-GCM-256, PBKDF2, per-credential salt),
// so only the `v1.â€¦` envelope â€” never plaintext â€” is stored in D1 or printed.
//
// Usage:
//   node --experimental-strip-types scripts/provision.mjs provider <id> <base-url> <default-model> [weight] [timeout-ms] [max-attempts] [--execute] [--env production|staging|dev] [--local]
//   node --experimental-strip-types scripts/provision.mjs credential <provider-id> <label> [weight] [--execute] [--env production|staging|dev] [--local]
//
// Default mode prints the ready-to-run `wrangler d1 execute` command (the SQL
// contains only ciphertext). With --execute the script runs wrangler itself so
// the operator's shell history never sees even the ciphertext.
//
// Requires Node >= 22.6 (type stripping) because it imports src/ai/crypto.ts.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sealCredential } from '../src/ai/crypto.ts';
import {
  buildCredentialInsertSql,
  buildProviderInsertSql,
  newCredentialId,
  validateCredentialParams,
  validateProviderParams,
} from '../src/admin/provisioning.ts';

const MAX_SECRET_BYTES = 4096;

/**
 * Reads a secret from stdin without echoing it.
 * - TTY: raw-mode read, masked with '*'; Enter submits, Backspace deletes,
 *   Ctrl+C aborts.
 * - Non-TTY: reads piped stdin until EOF (never echoed, never logged).
 */
export async function readSecretStdin(prompt = 'Secret (input hidden): ') {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    return await new Promise((resolve, reject) => {
      stdin.setRawMode(true);
      stdin.resume();
      let value = '';
      const cleanup = () => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
      };
      const onData = (chunk) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') {
            cleanup();
            process.stderr.write('\n');
            resolve(value);
            return;
          }
          if (char === '\u0003') {
            cleanup();
            process.stderr.write('\n');
            reject(new Error('Cancelled'));
            return;
          }
          if (char === '\u007f' || char === '\b') {
            value = value.slice(0, -1);
            continue;
          }
          if (value.length < MAX_SECRET_BYTES) {
            value += char;
            process.stderr.write('*');
          }
        }
      };
      stdin.on('data', onData);
      stdin.on('error', (error) => {
        cleanup();
        reject(error);
      });
    });
  }
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  process.stderr.write('\n');
  const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (value.length > MAX_SECRET_BYTES) throw new Error('Input too long');
  return value;
}

export function wranglerExecuteArgs(envName, sql, local) {
  const args = ['wrangler', 'd1', 'execute', 'DB', '--env', envName, '--command', sql, '-y'];
  args.push(local ? '--local' : '--remote');
  return args;
}

export function printUsage() {
  process.stderr.write([
    'HawkTalk provisioning CLI',
    '',
    'Create a provider (no secrets; safe for shell arguments):',
    '  node --experimental-strip-types scripts/provision.mjs provider <id> <base-url> <default-model> [weight] [timeout-ms] [max-attempts] [--execute] [--env production|staging|dev] [--local]',
    '',
    'Create a credential for an EXISTING provider (key read from hidden stdin):',
    '  node --experimental-strip-types scripts/provision.mjs credential <provider-id> <label> [weight] [--execute] [--env production|staging|dev] [--local]',
    '',
    'Without --execute the SQL is printed for you to run via wrangler d1 execute.',
    'With --execute this script runs wrangler itself (nothing enters your shell history).',
    '',
  ].join('\n'));
}

function parseGlobalFlags(argv) {
  const flags = { execute: false, envName: 'production', local: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') flags.execute = true;
    else if (arg === '--local') flags.local = true;
    else if (arg === '--env') {
      i += 1;
      flags.envName = argv[i] ?? '';
    } else if (arg.startsWith('--env=')) {
      flags.envName = arg.slice('--env='.length);
    } else positional.push(arg);
  }
  if (!['production', 'staging', 'dev'].includes(flags.envName)) {
    throw new Error('--env must be production, staging, or dev');
  }
  return { flags, positional };
}

async function readMasterSecret() {
  // The master secret never comes from CLI arguments. Either it is exported in
  // the current shell session (HAWKTALK_CREDENTIAL_MASTER_SECRET) or it is
  // entered at the hidden prompt. It is used only to derive the AES-GCM key
  // locally and is never stored, logged, or printed.
  const fromEnv = process.env.HAWKTALK_CREDENTIAL_MASTER_SECRET;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const secret = await readSecretStdin('CREDENTIAL_MASTER_SECRET (input hidden): ');
  if (secret.length === 0) throw new Error('CREDENTIAL_MASTER_SECRET must not be empty');
  return secret;
}

async function emit(sql, flags) {
  if (flags.execute) {
    const args = wranglerExecuteArgs(flags.envName, sql, flags.local);
    const result = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) throw new Error(`wrangler d1 execute failed (exit ${String(result.status)})`);
    process.stderr.write('Applied. Verify with:\n');
    process.stderr.write(`  npx wrangler d1 execute DB --env ${flags.envName}${flags.local ? ' --local' : ' --remote'} --command "SELECT id, label, weight, enabled FROM provider_credentials ORDER BY created_at DESC LIMIT 5;"\n`);
    return;
  }
  process.stderr.write('Sealed. Run this command to apply (contains ciphertext only â€” no plaintext, no master secret):\n\n');
  const args = wranglerExecuteArgs(flags.envName, sql, flags.local);
  process.stdout.write('npx ' + args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ') + '\n');
}

export async function run(argv) {
  const { flags, positional } = parseGlobalFlags(argv);
  const [command, ...rest] = positional;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  if (command === 'provider') {
    const [id, baseUrl, defaultModel, weightArg, timeoutArg, attemptsArg] = rest;
    const weight = weightArg !== undefined ? Number(weightArg) : 100;
    const timeoutMs = timeoutArg !== undefined ? Number(timeoutArg) : 30000;
    const maxCredentialAttempts = attemptsArg !== undefined ? Number(attemptsArg) : 3;
    // Shared validation (same rules as the Admin CMS, including SSRF checks).
    const params = validateProviderParams({ id, baseUrl, defaultModel, weight, timeoutMs, maxCredentialAttempts });
    const sql = buildProviderInsertSql(params, now);
    await emit(sql, flags);
    return;
  }

  if (command === 'credential') {
    const [providerId, label, weightArg] = rest;
    const weight = weightArg !== undefined ? Number(weightArg) : 100;
    const validated = validateCredentialParams({ providerId, label, weight });
    const plaintext = await readSecretStdin(`API key for provider "${validated.providerId}" (input hidden): `);
    if (plaintext.length === 0) throw new Error('API key must not be empty');
    // The only crypto path: the same sealCredential the Worker uses to decrypt.
    const ciphertext = await sealCredential(plaintext, await readMasterSecret());
    const id = newCredentialId(validated.providerId);
    const sql = buildCredentialInsertSql({ id, providerId: validated.providerId, label: validated.label, weight: validated.weight, sealedCiphertext: ciphertext }, now);
    await emit(sql, flags);
    return;
  }

  printUsage();
  throw new Error(`Unknown command: ${String(command)}`);
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  run(process.argv.slice(2)).then(
    () => { process.exitCode = 0; },
    (error) => {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
