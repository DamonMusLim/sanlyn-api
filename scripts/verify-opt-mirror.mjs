#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const DEFAULT_REMOTE = 'tencent';
const DEFAULT_REMOTE_DIR = '/opt/sanlyn-api-test';
const KEY_PATHS = [
  'server.js',
  'routes-core.js',
  'api/db/invoice-collab-confirm.js',
  'api/db/lib/confirm-lens.js',
  'public/templates/invoice-collab-section.js',
  'public/templates/invoice-official.js',
  'deploy/deploy-sanlyn-api',
  '.deployignore',
];

function usage() {
  console.log(`Usage: node scripts/verify-opt-mirror.mjs [--remote tencent] [--remote-dir /opt/sanlyn-api-test]

Read-only mirror check. Compares local and remote md5sum for deployment-critical
paths, then exits non-zero if /opt drift is detected.`);
}

function parseArgs(argv) {
  const args = { remote: DEFAULT_REMOTE, remoteDir: DEFAULT_REMOTE_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--help' || key === '-h') return { help: true };
    if (key === '--remote') {
      if (!val) throw new Error('--remote requires a value');
      args.remote = val;
      i += 1;
      continue;
    }
    if (key === '--remote-dir') {
      if (!val) throw new Error('--remote-dir requires a value');
      args.remoteDir = val;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return res.stdout;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseMd5Line(line) {
  const match = line.match(/^([a-fA-F0-9]{32})\s+\*?(.+)$/);
  if (!match) return null;
  return { hash: match[1].toLowerCase(), path: match[2] };
}

function localMd5(file) {
  const parsed = parseMd5Line(run('md5sum', ['--', file]).trim());
  if (!parsed) throw new Error(`Unable to parse local md5sum for ${file}`);
  return parsed.hash;
}

function remoteMd5(remote, remoteDir, file) {
  const cmd = `cd ${shellQuote(remoteDir)} && test -f ${shellQuote(file)} && md5sum -- ${shellQuote(file)}`;
  const res = spawnSync('ssh', [remote, cmd], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (res.status !== 0) return null;
  const parsed = parseMd5Line((res.stdout || '').trim());
  return parsed ? parsed.hash : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const drift = [];
  for (const file of KEY_PATHS) {
    if (!existsSync(file)) {
      drift.push({ file, reason: 'missing local file' });
      continue;
    }
    const local = localMd5(file);
    const remote = remoteMd5(args.remote, args.remoteDir, file);
    if (!remote) {
      drift.push({ file, reason: 'missing remote file' });
      continue;
    }
    if (local !== remote) drift.push({ file, reason: `md5 local=${local} remote=${remote}` });
  }

  if (drift.length) {
    console.error(`Mirror drift detected for ${args.remote}:${args.remoteDir}`);
    for (const item of drift) console.error(`  - ${item.file}: ${item.reason}`);
    process.exit(2);
  }

  console.log(`Mirror OK: ${KEY_PATHS.length} key files match ${args.remote}:${args.remoteDir}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
