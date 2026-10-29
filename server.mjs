#!/usr/bin/env node
// Cat Tower Factory daemon: dashboard + API, scheduler, dispatcher, runner and sweeps.
// Start with `node factory/server.mjs` (install.ps1 sets it to start at Windows logon).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, logActivity } from './lib/db.mjs';
import { loadConfig } from './lib/config.mjs';
import { DATA_DIR, SECRET_PATH, CONFIG_PATH, GUARDS_PATH, REPO_ROOT } from './lib/paths.mjs';
import { Runner, recoverOrphans } from './lib/runner.mjs';
import { dispatchTick } from './lib/dispatcher.mjs';
import { schedulerTick, initLoops } from './lib/scheduler.mjs';
import { sweepIdle } from './lib/resources.mjs';
import { usageSweep } from './lib/usage.mjs';
import { tailBus } from './lib/bus.mjs';
import { notify } from './lib/notify.mjs';
import { createApi } from './lib/api.mjs';
import { kvGet, kvSet } from './lib/db.mjs';
import { ensureStandingIdea } from './lib/ideas.mjs';

fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG = path.join(DATA_DIR, 'factory.log');
const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG, `${line}\n`); } catch { /* ignore */ }
};

if (!fs.existsSync(SECRET_PATH)) fs.writeFileSync(SECRET_PATH, crypto.randomBytes(24).toString('hex'));
const secret = fs.readFileSync(SECRET_PATH, 'utf8').trim();

let cfg = loadConfig();
const mtimes = () => [CONFIG_PATH, GUARDS_PATH].map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(':');
let cfgStamp = mtimes();
const db = openDb();
const port = Number(process.env.FACTORY_PORT || cfg.settings.port);

const runner = new Runner(db, cfg, {
  onEvent: (e) => { if (e.type === 'run-end') log('run', e.runId, e.status); else log('run', e.runId, 'started'); },
});

const api = createApi({ db, getCfg: () => cfg, runner, secret, port });
api.on('error', (err) => {
  if (err.code === 'EADDRINUSE') { log(`Factory already running on port ${port}; exiting.`); process.exit(0); }
  log('server error', err.message);
});

function safe(name, fn) {
  return () => { try { fn(); } catch (err) { log(`${name} failed:`, err.stack || err.message); } };
}

// Toast for anything new in "Needs you".
const notifyTick = safe('notify', () => {
  const seen = Number(kvGet(db, 'notified_question', '0'));
  const fresh = db.prepare("SELECT * FROM questions WHERE status = 'open' AND id > ? ORDER BY id").all(seen);
  for (const q of fresh) {
    const title = q.kind === 'approval' ? 'New idea needs your approval' : q.kind === 'failure' ? 'A Factory run failed' : 'An agent has a question';
    notify(title, q.text, `http://127.0.0.1:${port}/#home`);
  }
  if (fresh.length) kvSet(db, 'notified_question', fresh.at(-1).id);
  const seenPass = Number(kvGet(db, 'notified_proposal', '0'));
  const passes = db.prepare("SELECT * FROM proposals WHERE status = 'pending' AND id > ? ORDER BY id").all(seenPass);
  for (const p of passes) notify('New pass to approve', `${p.title}: ${JSON.parse(p.tasks).length} tasks`, `http://127.0.0.1:${port}/#backlog`);
  if (passes.length) kvSet(db, 'notified_proposal', passes.at(-1).id);
});

const reloadTick = safe('config reload', () => {
  const stamp = mtimes();
  if (stamp === cfgStamp) return;
  cfg = loadConfig();
  cfgStamp = stamp;
  runner.setConfig(cfg);
  initLoops(db, cfg);
  log('config reloaded');
});

const pruneTick = safe('prune', () => {
  db.prepare('DELETE FROM activity WHERE ts < ?').run(new Date(Date.now() - 30 * 86400_000).toISOString());
});

// FACTORY_DEMO=1: serve a seeded demo DB read-mostly — no orphan recovery, sweeps or automation.
const DEMO = process.env.FACTORY_DEMO === '1';

api.listen(port, '127.0.0.1', () => {
  if (DEMO) { log(`Cat Tower Factory DEMO on http://127.0.0.1:${port}`); return; }
  const orphans = recoverOrphans(db);
  initLoops(db, cfg);
  ensureStandingIdea(db, cfg, 'fixes');
  ensureStandingIdea(db, cfg, 'bible');
  if (kvGet(db, 'notified_question', null) === null) {
    kvSet(db, 'notified_question', db.prepare('SELECT COALESCE(MAX(id), 0) m FROM questions').get().m);
  }
  logActivity(db, { role: 'factory', kind: 'status', summary: `Factory started${orphans ? ` (${orphans} orphaned run(s) marked failed)` : ''}` });
  log(`Cat Tower Factory on http://127.0.0.1:${port} (repo ${REPO_ROOT})`);

  const every = (ms, fn) => { fn(); return setInterval(fn, ms); };
  every(15_000, safe('dispatch', () => dispatchTick(db, cfg, runner)));
  every(30_000, safe('scheduler', () => { const fired = schedulerTick(db, cfg, runner); if (fired.length) log('loops fired', fired.join(',')); }));
  every(60_000, safe('idle sweep', () => sweepIdle(db, cfg)));
  every(5 * 60_000, safe('usage', () => usageSweep(db)));
  every(10_000, safe('bus', () => tailBus(db)));
  every(5_000, notifyTick);
  every(30_000, reloadTick);
  every(6 * 3600_000, pruneTick);
});

function shutdown(sig) {
  log(`received ${sig}; stopping active runs`);
  for (const id of [...runner.procs.keys()]) runner.stop(id);
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
