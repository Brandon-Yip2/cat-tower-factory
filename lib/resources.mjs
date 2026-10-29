// Single-user tools (Roblox Studio, Blender, the asset uploader, git commit): who holds each one,
// why, and who is queued. Claims run inside IMMEDIATE transactions so two processes can't both win.
import path from 'node:path';
import { now } from './db.mjs';
import { REPO_ROOT } from './paths.mjs';

const QUEUE_RESERVE_MS = 15 * 60_000;
const regexCache = new Map();
const re = (src) => {
  if (!regexCache.has(src)) regexCache.set(src, new RegExp(src, 'i'));
  return regexCache.get(src);
};

export function commandOf(toolName, toolInput) {
  if (!toolInput) return '';
  if (toolName === 'Bash' || toolName === 'PowerShell') return String(toolInput.command || '');
  return '';
}

export function matchResource(cfg, toolName, toolInput) {
  const cmd = commandOf(toolName, toolInput);
  for (const r of cfg.resources) {
    const toolHit = (r.tools || []).some((p) => re(p).test(toolName))
      && !(r.exceptTools || []).some((p) => re(p).test(toolName));
    const cmdHit = cmd && (r.commands || []).some((p) => re(p).test(cmd));
    if (toolHit || cmdHit) return r.id;
  }
  return null;
}

export const holderKey = ({ runId, sessionId }) => (runId ? `run:${runId}` : `session:${sessionId}`);

const liveHolds = (db, resourceId) =>
  db.prepare('SELECT * FROM holds WHERE resource_id = ? AND released_at IS NULL ORDER BY claimed_at').all(resourceId);

const queueOf = (db, resourceId) =>
  db.prepare('SELECT * FROM queue WHERE resource_id = ? ORDER BY requested_at, id').all(resourceId);

// who: { key, kind: 'factory'|'interactive', runId?, sessionId?, role, reason, ideaId? }
export function claim(db, cfg, resourceId, who) {
  const res = cfg.resources.find((r) => r.id === resourceId);
  if (!res) throw new Error(`unknown tool "${resourceId}"`);
  return db.transaction(() => {
    const t = now();
    const holds = liveHolds(db, resourceId);
    const mine = holds.find((h) => h.holder_key === who.key);
    if (mine) {
      db.prepare('UPDATE holds SET last_used_at = ? WHERE id = ?').run(t, mine.id);
      return { ok: true, already: true, hold: mine };
    }
    const queue = queueOf(db, resourceId);
    const head = queue.find((q) => Date.now() - Date.parse(q.requested_at) < QUEUE_RESERVE_MS);
    // The owner's own sessions never wait in (or block) the queue: they get the tool if it is free.
    const reservedForOther = head && head.holder_key !== who.key && who.kind !== 'interactive';
    if (holds.length < (res.capacity || 1) && !reservedForOther) {
      db.prepare(`INSERT INTO holds (resource_id, holder_key, holder_kind, run_id, session_id, role, reason, idea_id,
          claimed_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(resourceId, who.key, who.kind || 'factory', who.runId || null, who.sessionId || null, who.role || null,
          who.reason || null, who.ideaId || null, t, t);
      db.prepare('DELETE FROM queue WHERE resource_id = ? AND holder_key = ?').run(resourceId, who.key);
      return { ok: true };
    }
    if (who.kind === 'interactive') return { ok: false, holders: holds, reservedFor: null, position: 0 };
    db.prepare(`INSERT OR IGNORE INTO queue (resource_id, holder_key, run_id, role, reason, idea_id, requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(resourceId, who.key, who.runId || null, who.role || null, who.reason || null, who.ideaId || null, t);
    const position = queueOf(db, resourceId).findIndex((q) => q.holder_key === who.key) + 1;
    return { ok: false, holders: holds, reservedFor: reservedForOther && holds.length < res.capacity ? head : null, position };
  }).immediate();
}

export function touch(db, resourceId, key) {
  db.prepare('UPDATE holds SET last_used_at = ? WHERE resource_id = ? AND holder_key = ? AND released_at IS NULL')
    .run(now(), resourceId, key);
}

export function release(db, resourceId, key, reason = 'released') {
  const r = db.prepare(`UPDATE holds SET released_at = ?, release_reason = ?
    WHERE resource_id = ? AND holder_key = ? AND released_at IS NULL`).run(now(), reason, resourceId, key);
  db.prepare('DELETE FROM queue WHERE resource_id = ? AND holder_key = ?').run(resourceId, key);
  return r.changes > 0;
}

export function forceRelease(db, resourceId, reason = 'force-released by owner') {
  const r = db.prepare(`UPDATE holds SET released_at = ?, release_reason = ?
    WHERE resource_id = ? AND released_at IS NULL`).run(now(), reason, resourceId);
  return r.changes;
}

// Everything a holder has: tools, queue places, file claims.
export function releaseAll(db, key, reason = 'run ended') {
  const t = now();
  db.prepare('UPDATE holds SET released_at = ?, release_reason = ? WHERE holder_key = ? AND released_at IS NULL').run(t, reason, key);
  db.prepare('DELETE FROM queue WHERE holder_key = ?').run(key);
  db.prepare('UPDATE file_claims SET released_at = ? WHERE holder_key = ? AND released_at IS NULL').run(t, key);
}

// Release holds nobody is using, and holds/queue places of runs that are no longer running.
export function sweepIdle(db, cfg, at = Date.now()) {
  const g = cfg.guards;
  const released = [];
  for (const h of db.prepare('SELECT * FROM holds WHERE released_at IS NULL').all()) {
    let dead = false;
    if (h.run_id) {
      const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(h.run_id);
      dead = !run || !['running'].includes(run.status);
    }
    const idleMin = (at - Date.parse(h.last_used_at)) / 60_000;
    const limit = h.resource_id === 'studio' && h.holder_kind === 'factory' ? g.studioIdleMinutes : g.idleReleaseMinutes;
    if (dead || idleMin >= limit) {
      const why = dead ? 'holder run ended' : `idle ${Math.round(idleMin)} min`;
      db.prepare('UPDATE holds SET released_at = ?, release_reason = ? WHERE id = ?').run(now(), why, h.id);
      released.push({ ...h, why });
    }
  }
  for (const q of db.prepare('SELECT * FROM queue').all()) {
    const stale = at - Date.parse(q.requested_at) > QUEUE_RESERVE_MS;
    const run = q.run_id ? db.prepare('SELECT status FROM runs WHERE id = ?').get(q.run_id) : null;
    if (stale || (q.run_id && (!run || run.status !== 'running'))) db.prepare('DELETE FROM queue WHERE id = ?').run(q.id);
  }
  return released;
}

export function resourceView(db, cfg) {
  return cfg.resources.map((r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon || '',
    capacity: r.capacity || 1,
    holders: liveHolds(db, r.id),
    queue: queueOf(db, r.id),
    last: db.prepare(`SELECT role, reason, released_at, release_reason FROM holds
      WHERE resource_id = ? AND released_at IS NOT NULL ORDER BY released_at DESC LIMIT 1`).get(r.id) || null,
  }));
}

export function claimFiles(db, who, paths, reason = '') {
  const t = now();
  const stmt = db.prepare(`INSERT INTO file_claims (path, holder_key, run_id, role, reason, claimed_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const p of paths) stmt.run(normPath(p), who.key, who.runId || null, who.role || null, reason, t);
}

// Repo-relative, forward slashes, so claims and edits compare equal however they were written.
export function normPath(p, root = REPO_ROOT) {
  const s = String(p);
  const rel = path.isAbsolute(s) ? path.relative(root, s) : s;
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function liveFileClaims(db) {
  return db.prepare(`SELECT path, holder_key, run_id, role, reason, claimed_at FROM file_claims
    WHERE released_at IS NULL ORDER BY claimed_at`).all();
}
