import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRun, prevRun, describeCron } from '../lib/cron.mjs';
import { openDb, changeSeq } from '../lib/db.mjs';
import { createIdea, updateIdea, decideApproval, ApprovalError, listIdeas } from '../lib/ideas.mjs';
import { matchResource, claim, release, sweepIdle, releaseAll } from '../lib/resources.mjs';
import { fixture } from './helpers.mjs';

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

test('cron next/prev and descriptions', () => {
  assert.deepEqual(nextRun('0 9 * * *', local(2026, 10, 29, 10, 0)), local(2026, 10, 30, 9, 0));
  // Wed 2026-10-28 → Thu 2026-10-29 10:00
  assert.deepEqual(nextRun('0 10 * * 1,4', local(2026, 10, 28, 12, 0)), local(2026, 10, 29, 10, 0));
  assert.deepEqual(nextRun('0 8 */3 * *', local(2026, 10, 2, 9, 0)), local(2026, 10, 4, 8, 0));
  assert.deepEqual(prevRun('0 2 * * *', local(2026, 10, 29, 5, 0)), local(2026, 10, 29, 2, 0));
  assert.equal(describeCron('0 9 * * *'), 'Daily at 09:00');
  assert.equal(describeCron('0 10 * * 1,4'), 'Mon & Thu at 10:00');
  assert.equal(describeCron('0 8 */3 * *'), 'Every 3 days at 08:00');
});

test('db migrates idempotently and bumps change_seq', () => {
  const db = openDb(':memory:');
  openDb(':memory:');
  const before = changeSeq(db);
  db.prepare("INSERT INTO kv (key, value) VALUES ('x', '1')").run();
  db.prepare("INSERT INTO messages (ts, from_role, to_role, text) VALUES ('t', 'owner', 'qa-lead', 'hi')").run();
  assert.ok(changeSeq(db) > before);
});

test('approval rule: owner, agent bug, agent feature with and without parent', () => {
  const { db, cfg } = fixture();
  const owner = createIdea(db, cfg, { title: 'Daily fish bonus', origin: 'owner' });
  assert.equal(owner.approval, 'approved');
  const bug = createIdea(db, cfg, { title: 'HUD overlap', origin: 'qa', kind: 'bug', originRole: 'qa-lead' });
  assert.equal(bug.approval, 'approved');
  const child = createIdea(db, cfg, { title: 'Fish streak icon', origin: 'agent', kind: 'feature', parentId: owner.id });
  assert.equal(child.approval, 'approved');
  const fresh = createIdea(db, cfg, { title: 'Endgame raid mode', origin: 'agent', kind: 'feature', originRole: 'design-lead' });
  assert.equal(fresh.approval, 'needs_owner');

  const triaged = updateIdea(db, cfg, fresh.id, { status: 'triaged', owner_role: 'design-lead' }, 'game-manager');
  assert.equal(triaged.status, 'needs_approval');
  assert.throws(() => updateIdea(db, cfg, fresh.id, { status: 'building' }, 'engineering-lead'), ApprovalError);
  const q = db.prepare("SELECT * FROM questions WHERE idea_id = ? AND kind = 'approval'").get(fresh.id);
  assert.ok(q && q.status === 'open');

  const ok = decideApproval(db, cfg, fresh.id, true);
  assert.equal(ok.status, 'triaged');
  assert.equal(updateIdea(db, cfg, fresh.id, { status: 'building' }, 'engineering-lead').status, 'building');
  assert.equal(db.prepare('SELECT status FROM questions WHERE id = ?').get(q.id).status, 'answered');
});

test('rework counts qa → building and shipped sets shipped_at', () => {
  const { db, cfg } = fixture();
  const i = createIdea(db, cfg, { title: 'Canopy respawn', origin: 'owner' });
  updateIdea(db, cfg, i.id, { status: 'building' });
  updateIdea(db, cfg, i.id, { status: 'qa' });
  assert.equal(updateIdea(db, cfg, i.id, { status: 'building', note: 'still clips' }).rework_count, 1);
  updateIdea(db, cfg, i.id, { status: 'qa' });
  const shipped = updateIdea(db, cfg, i.id, { status: 'shipped' });
  assert.ok(shipped.shipped_at);
  assert.equal(listIdeas(db, { stageGroup: 'done' }).length, 1);
  assert.equal(listIdeas(db, { stageGroup: 'active' }).length, 0);
});

test('triage cannot make the foreman the builder or use the triage task type', () => {
  const { db, cfg } = fixture();
  const i = createIdea(db, cfg, { title: 'E2E hello', origin: 'owner', kind: 'tech' });
  assert.throws(() => updateIdea(db, cfg, i.id, { status: 'triaged', owner_role: 'game-manager' }, 'game-manager'), /building role/);
  assert.throws(() => updateIdea(db, cfg, i.id, { status: 'triaged', task_type: 'triage' }, 'game-manager'), /task_type/);
  const ok = updateIdea(db, cfg, i.id, { status: 'triaged', owner_role: 'factory-engineer', task_type: 'factory-review' }, 'game-manager');
  assert.equal(ok.owner_role, 'factory-engineer');
});

test('resource matching', () => {
  const { cfg } = fixture();
  assert.equal(matchResource(cfg, 'mcp__Roblox_Studio__execute_luau', {}), 'studio');
  assert.equal(matchResource(cfg, 'mcp__Roblox_Studio__list_roblox_studios', {}), null);
  assert.equal(matchResource(cfg, 'Bash', { command: 'node tools/push-server.mjs place/scripts/A.luau' }), 'studio');
  assert.equal(matchResource(cfg, 'PowerShell', { command: 'git add x; git commit -m "y"' }), 'git');
  assert.equal(matchResource(cfg, 'Bash', { command: 'git -C /c/RobloxAI commit -m wip' }), 'git');
  assert.equal(matchResource(cfg, 'Bash', { command: 'git status' }), null);
  assert.equal(matchResource(cfg, 'mcp__blender__execute_code', {}), 'blender');
  assert.equal(matchResource(cfg, 'Bash', { command: 'ls' }), null);
});

test('claim, deny with queue position, release, reservation, idle sweep', () => {
  const { db, cfg } = fixture();
  const a = { key: 'run:a', kind: 'factory', runId: 'a', role: 'qa-lead', reason: 'regression' };
  const b = { key: 'run:b', kind: 'factory', runId: 'b', role: 'art-director', reason: 'import' };
  const c = { key: 'run:c', kind: 'factory', runId: 'c', role: 'engineering-lead', reason: 'push' };
  for (const id of ['a', 'b', 'c']) {
    db.prepare("INSERT INTO runs (id, kind, status, started_at) VALUES (?, 'factory', 'running', ?)").run(id, new Date().toISOString());
  }
  assert.equal(claim(db, cfg, 'studio', a).ok, true);
  assert.equal(claim(db, cfg, 'studio', a).already, true);
  const denied = claim(db, cfg, 'studio', b);
  assert.equal(denied.ok, false);
  assert.equal(denied.position, 1);
  assert.equal(denied.holders[0].role, 'qa-lead');
  release(db, 'studio', 'run:a');
  // b queued first, so c is held back while b's place is reserved.
  assert.equal(claim(db, cfg, 'studio', c).ok, false);
  assert.equal(claim(db, cfg, 'studio', b).ok, true);

  // Ending b's run lets the sweep free Studio.
  db.prepare("UPDATE runs SET status = 'done' WHERE id = 'b'").run();
  const freed = sweepIdle(db, cfg);
  assert.equal(freed.length, 1);
  assert.equal(claim(db, cfg, 'studio', c).ok, true);

  // Idle interactive hold is released after idleReleaseMinutes.
  const me = { key: 'session:s1', kind: 'interactive', sessionId: 's1', role: 'owner' };
  assert.equal(claim(db, cfg, 'blender', me).ok, true);
  assert.equal(sweepIdle(db, cfg, Date.now() + 11 * 60_000).some((h) => h.resource_id === 'blender'), true);
  releaseAll(db, 'run:c');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM holds WHERE released_at IS NULL').get().n, 0);
});

test('claim race: only one of two contenders wins', () => {
  const { db, cfg } = fixture();
  const results = [1, 2].map((n) => claim(db, cfg, 'git', { key: `session:${n}`, kind: 'interactive', sessionId: String(n) }));
  assert.deepEqual(results.map((r) => r.ok), [true, false]);
});
