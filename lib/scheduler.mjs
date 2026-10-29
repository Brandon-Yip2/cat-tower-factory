// Scheduled loops: fire each loop once per cron slot while the PC is on, and catch up a slot
// missed while it was off (within catchUpHours).
import { now } from './db.mjs';
import { nextRun, prevRun, describeCron } from './cron.mjs';
import { roleById } from './config.mjs';
import { isPaused, budgetState } from './dispatcher.mjs';

function stateOf(db, loopId) {
  return db.prepare('SELECT * FROM loop_state WHERE loop_id = ?').get(loopId) || null;
}

export function isEnabled(db, loop) {
  const s = stateOf(db, loop.id);
  return s && s.enabled !== null ? !!s.enabled : loop.enabled !== false;
}

export function setEnabled(db, loopId, enabled) {
  db.prepare(`INSERT INTO loop_state (loop_id, enabled) VALUES (?, ?)
    ON CONFLICT(loop_id) DO UPDATE SET enabled = excluded.enabled`).run(loopId, enabled ? 1 : 0);
}

// First boot: treat every loop as just fired so installing doesn't trigger a burst of catch-ups.
export function initLoops(db, cfg) {
  for (const loop of cfg.loops) {
    db.prepare('INSERT OR IGNORE INTO loop_state (loop_id, last_fired_at) VALUES (?, ?)').run(loop.id, now());
  }
}

export function fireLoop(db, cfg, runner, loop, { ownerAction = false } = {}) {
  const runId = runner.start({ role: loop.role, purpose: loop.name, prompt: loop.prompt, loopId: loop.id, taskType: loop.taskType, ownerAction });
  db.prepare(`INSERT INTO loop_state (loop_id, last_fired_at, last_run_id, last_status) VALUES (?, ?, ?, 'running')
    ON CONFLICT(loop_id) DO UPDATE SET last_fired_at = excluded.last_fired_at, last_run_id = excluded.last_run_id,
    last_status = 'running', last_summary = NULL`).run(loop.id, now(), runId);
  return runId;
}

export function schedulerTick(db, cfg, runner, at = new Date()) {
  const fired = [];
  if (isPaused(db) || budgetState(db, cfg).exhausted) return fired;
  for (const loop of cfg.loops) {
    if (!isEnabled(db, loop)) continue;
    const slot = prevRun(loop.cron, at, Math.max(cfg.guards.catchUpHours, 1));
    if (!slot) continue;
    const s = stateOf(db, loop.id);
    if (s?.last_fired_at && Date.parse(s.last_fired_at) >= slot.getTime()) continue;
    if (s?.last_run_id && runner.isActive(s.last_run_id)) continue;
    if (runner.activeCount() >= cfg.guards.maxConcurrentRuns) break;
    fired.push(fireLoop(db, cfg, runner, loop));
  }
  return fired;
}

export function loopView(db, cfg, at = new Date()) {
  return cfg.loops.map((loop) => {
    const s = stateOf(db, loop.id) || {};
    const enabled = isEnabled(db, loop);
    let next = null;
    try { next = enabled ? nextRun(loop.cron, at).toISOString() : null; } catch { next = null; }
    return {
      id: loop.id, name: loop.name, cron: loop.cron, schedule: describeCron(loop.cron), role: loop.role,
      roleName: roleById(cfg, loop.role)?.name || loop.role, enabled, next,
      lastFiredAt: s.last_fired_at || null, lastRunId: s.last_run_id || null, lastStatus: s.last_status || null,
      lastSummary: s.last_summary || null, prompt: loop.prompt,
    };
  });
}
