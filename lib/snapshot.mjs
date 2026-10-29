// The compact "FACTORY NOW" picture every agent gets at session start (and on demand through
// the factory_status tool). Kept short on purpose: it is paid for in tokens on every run.
import { now } from './db.mjs';
import { resourceView, liveFileClaims } from './resources.mjs';
import { roleById } from './config.mjs';

const mins = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
const short = (s, n = 60) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

export function roleName(cfg, id) {
  if (!id) return 'someone';
  if (id === 'owner') return 'Owner';
  if (id === 'owner-session') return 'Owner session';
  return roleById(cfg, id)?.name || id;
}

export function describeHolder(cfg, h) {
  return `${roleName(cfg, h.role)}${h.holder_kind === 'interactive' ? ' (interactive)' : ''} — ${short(h.reason || 'no reason given', 70)}, ${mins(h.claimed_at)}m`;
}

// Pending messages addressed to this run or its role; marks them delivered.
export function takeMessages(db, who) {
  if (!who.runId) return [];
  const rows = db.prepare(`SELECT * FROM messages WHERE delivered_at IS NULL AND to_role != 'owner'
    AND ((run_id IS NOT NULL AND run_id = @run) OR (run_id IS NULL AND to_role = @role)) ORDER BY id`)
    .all({ run: who.runId, role: who.role || '' });
  const mark = db.prepare('UPDATE messages SET delivered_at = ?, delivered_run_id = ? WHERE id = ?');
  for (const m of rows) mark.run(now(), who.runId, m.id);
  return rows;
}

export function formatMessages(cfg, rows) {
  return rows.map((m) => `- ${m.kind === 'answer' ? 'Owner answered' : `From ${roleName(cfg, m.from_role)}`}: ${m.text}`).join('\n');
}

export function buildSnapshot(db, cfg, who = {}, { full = false } = {}) {
  const lines = [];
  const time = new Date().toTimeString().slice(0, 5);
  lines.push(`FACTORY NOW (${time}) — shared state of the Cat Tower Factory. Use the factory MCP tools for more.`);

  const tools = resourceView(db, cfg).map((r) => {
    if (!r.holders.length) return `${r.name}: free`;
    const q = r.queue.length ? ` · queue: ${r.queue.map((x) => roleName(cfg, x.role)).join(', ')}` : '';
    return `${r.name}: ${r.holders.map((h) => describeHolder(cfg, h)).join('; ')}${q}`;
  });
  lines.push(`Tools: ${tools.join(' | ')}`);

  const running = db.prepare(`SELECT r.id, r.role, r.status, r.purpose, r.started_at, r.kind, i.id AS idea, i.title
    FROM runs r LEFT JOIN ideas i ON i.id = r.idea_id
    WHERE r.status IN ('running','parked') AND (r.kind = 'factory' OR r.last_activity_at >= ?)
    ORDER BY r.started_at LIMIT ?`).all(new Date(Date.now() - 30 * 60_000).toISOString(), full ? 30 : 8);
  if (running.length) {
    lines.push('Working now:');
    for (const r of running) {
      const me = who.runId && r.id === who.runId ? ' (you)' : '';
      const what = r.idea ? `#${r.idea} ${short(r.title, 50)}` : short(r.purpose, 60);
      lines.push(`- ${roleName(cfg, r.role)}${me}: ${what} — ${r.status === 'parked' ? 'waiting on owner' : `${mins(r.started_at)}m`}`);
    }
  }

  const claims = liveFileClaims(db);
  if (claims.length) {
    const shown = claims.slice(0, full ? 50 : 10);
    lines.push(`Files claimed: ${shown.map((c) => `${c.path} [${roleName(cfg, c.role)}]`).join('; ')}${claims.length > shown.length ? ` (+${claims.length - shown.length} more)` : ''}`);
  }

  if (who.ideaId) {
    const i = db.prepare('SELECT * FROM ideas WHERE id = ?').get(who.ideaId);
    if (i) {
      lines.push(`Your idea: #${i.id} "${i.title}" — status ${i.status}${i.spec_path ? `, spec ${i.spec_path}` : ''}${i.rework_count ? `, rework ${i.rework_count}` : ''}`);
      const last = db.prepare("SELECT actor, text FROM idea_events WHERE idea_id = ? AND kind IN ('note','status') ORDER BY id DESC LIMIT 1").get(i.id);
      if (last) lines.push(`Latest note (${roleName(cfg, last.actor)}): ${short(last.text, 200)}`);
    }
  }

  const waiting = db.prepare("SELECT COUNT(*) n FROM questions WHERE status = 'open'").get().n;
  const counts = db.prepare(`SELECT status, COUNT(*) n FROM ideas WHERE status NOT IN ('shipped','rejected') GROUP BY status`).all();
  if (counts.length) lines.push(`Pipeline: ${counts.map((c) => `${c.status} ${c.n}`).join(', ')}; ${waiting} question(s) waiting on owner.`);

  return lines.join('\n');
}
