import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdea, updateIdea } from '../lib/ideas.mjs';
import { proposePass, approvePass, denyPass, pendingProposals } from '../lib/proposals.mjs';
import { dispatchTick } from '../lib/dispatcher.mjs';
import { fixture } from './helpers.mjs';

const gm = { role: 'game-manager', runId: null };

function fakeRunner(db) {
  const active = new Set();
  const started = [];
  let n = 0;
  return {
    started,
    activeCount: () => active.size,
    isActive: (id) => active.has(id),
    start(opts) {
      n += 1;
      const id = `f-${n}`;
      db.prepare(`INSERT INTO runs (id, kind, role, idea_id, session_id, status, purpose, prompt, started_at)
        VALUES (?, 'factory', ?, ?, ?, 'running', ?, ?, ?)`).run(id, opts.role, opts.ideaId || null, `s-${n}`, opts.purpose, opts.prompt, new Date().toISOString());
      active.add(id);
      started.push({ id, ...opts });
      return id;
    },
    resumeWith() { return 'r'; },
    end(id) { active.delete(id); db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(new Date().toISOString(), id); },
  };
}

const tasks = [
  { title: 'Seedlight particle polish', owner_role: 'art-director', task_type: 'blender-mesh', kind: 'polish' },
  { title: 'Charm drop rates', owner_role: 'balance-lead', task_type: 'balance-config', kind: 'tuning' },
  { title: 'Charm tooltips text', owner_role: 'narrative-director', task_type: 'story-text', kind: 'content', after: [2] },
];

test('a pass is validated, waits for the owner, and only one waits at a time', () => {
  const { db, cfg } = fixture();
  assert.throws(() => proposePass(db, cfg, gm, { title: 'x', why: 'y', tasks: [{ title: 'a', owner_role: 'game-manager' }] }), /owner_role/);
  assert.throws(() => proposePass(db, cfg, gm, { title: 'x', why: 'y', tasks: [{ title: 'a', owner_role: 'art-director', after: [1] }] }), /after/);
  const id = proposePass(db, cfg, gm, { title: 'Charms polish', why: 'Make charms feel good.', tasks });
  assert.equal(pendingProposals(db, cfg)[0].tasks[0].roleName, 'Art Director');
  assert.throws(() => proposePass(db, cfg, gm, { title: 'another', why: 'y', tasks }), /still waiting/);
  assert.ok(id);
});

test('approving with additions creates ordered, owner-approved backlog ideas and tells the planner', () => {
  const { db, cfg } = fixture();
  const suggestion = createIdea(db, cfg, { title: 'Seasonal hats', origin: 'agent', kind: 'feature', originRole: 'art-director' });
  updateIdea(db, cfg, suggestion.id, { status: 'triaged' }, 'game-manager');
  const id = proposePass(db, cfg, gm, { title: 'Charms polish', why: 'Make charms feel good.',
    tasks: [...tasks, { idea_id: suggestion.id, owner_role: 'art-director', task_type: 'blender-mesh' }] });
  const { approved } = approvePass(db, cfg, id, 'Keep the particles subtle on phones.');
  assert.equal(approved.length, 4);
  const rows = approved.map((x) => db.prepare('SELECT * FROM ideas WHERE id = ?').get(x));
  assert.ok(rows.every((r) => r.status === 'triaged' && r.approval === 'owner_approved' && r.pass_label === 'Charms polish'));
  assert.match(rows[0].description, /Keep the particles subtle/);
  assert.deepEqual(JSON.parse(rows[2].depends_on), [approved[1]]);
  assert.ok(rows[0].rank < rows[1].rank && rows[1].rank < rows[2].rank);
  assert.equal(rows[3].id, suggestion.id, 'the suggested idea is approved, not duplicated');
  const msg = db.prepare("SELECT * FROM messages WHERE to_role = 'game-manager' ORDER BY id DESC").get();
  assert.match(msg.text, /approved the idea "Charms polish" \(#[0-9]+\) with these additions/);
  assert.equal(pendingProposals(db, cfg).length, 0);
});

test('denying a pass tells the planner why', () => {
  const { db, cfg } = fixture();
  const id = proposePass(db, cfg, gm, { title: 'Hats', why: 'y', tasks });
  denyPass(db, id, 'Not now, finish Pass 6 first.');
  assert.match(db.prepare("SELECT text FROM messages WHERE to_role = 'game-manager'").get().text, /finish Pass 6 first/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ideas').get().n, 0);
});

test('six agents at once, but no more than the per-role cap', () => {
  const { db, cfg } = fixture();
  const runner = fakeRunner(db);
  for (let k = 0; k < 5; k += 1) {
    const i = createIdea(db, cfg, { title: `art ${k}`, origin: 'owner' });
    updateIdea(db, cfg, i.id, { status: 'triaged', owner_role: 'art-director' }, 'owner');
  }
  for (let k = 0; k < 2; k += 1) {
    const i = createIdea(db, cfg, { title: `audio ${k}`, origin: 'owner' });
    updateIdea(db, cfg, i.id, { status: 'triaged', owner_role: 'audio-director' }, 'owner');
  }
  dispatchTick(db, cfg, runner);
  const byRole = runner.started.reduce((m, s) => ({ ...m, [s.role]: (m[s.role] || 0) + 1 }), {});
  assert.equal(byRole['art-director'], cfg.guards.perRoleMax.default);
  assert.equal(byRole['audio-director'], 2);
});

test('idle agents with an empty backlog make the Game Manager plan, once per cooldown', () => {
  const { db, cfg } = fixture();
  const runner = fakeRunner(db);
  dispatchTick(db, cfg, runner);
  assert.equal(runner.started.length, 1);
  assert.equal(runner.started[0].purpose, 'Plan the next work');
  assert.match(runner.started[0].prompt, /propose_pass/);
  dispatchTick(db, cfg, runner);
  assert.equal(runner.started.length, 1, 'no second planner while one is running');
  runner.end(runner.started[0].id);
  dispatchTick(db, cfg, runner);
  assert.equal(runner.started.length, 1, 'cooldown after a planning run');
  proposePass(db, cfg, gm, { title: 'p', why: 'w', tasks });
  dispatchTick(db, cfg, runner, Date.now() + 3600_000);
  assert.equal(runner.started.length, 2, 'idle agents still get tasks under existing ideas while a new idea waits');
  assert.match(runner.started[1].prompt, /already waiting for the owner, so do not propose another/);
});
