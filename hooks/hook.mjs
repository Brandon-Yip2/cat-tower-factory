#!/usr/bin/env node
// Claude Code hook entry for the Cat Tower Factory: `node factory/hooks/hook.mjs <Event>`.
// Fails open — any problem (no node_modules, no DB, bad input) means exit 0 with no output,
// so the Factory can never break a normal Claude Code session.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const event = process.argv[2];
const here = path.dirname(fileURLToPath(import.meta.url));

function logError(err) {
  try {
    const dir = path.join(here, '..', 'data');
    if (fs.existsSync(dir)) fs.appendFileSync(path.join(dir, 'hook-errors.log'), `${new Date().toISOString()} ${event} ${err?.stack || err}\n`);
  } catch { /* nothing else to do */ }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = raw ? JSON.parse(raw) : {};
  if (process.env.FACTORY_DISABLE_HOOKS === '1') return;
  const { openDb } = await import('../lib/db.mjs');
  const { loadConfig } = await import('../lib/config.mjs');
  const { handleHook } = await import('../lib/hookcore.mjs');
  const db = openDb();
  try {
    const out = handleHook(db, loadConfig(), event, input, process.env);
    if (out) process.stdout.write(JSON.stringify(out));
  } finally {
    db.close();
  }
}

const timer = setTimeout(() => process.exit(0), 4000);
main().catch(logError).finally(() => { clearTimeout(timer); process.exitCode = 0; });
