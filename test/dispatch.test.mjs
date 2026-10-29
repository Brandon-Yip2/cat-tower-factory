import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdea, updateIdea } from '../lib/ideas.mjs';
import { dispatchTick, budgetState } from '../lib/dispatcher.mjs';
import { schedulerTick, initLoops, setEnabled, loopView } from '../lib/scheduler.mjs';
import { kvSet } from '../lib/db.mjs';
import { fixture } from './helpers.mjs';

// A runner double that records starts and lets tests finish runs by hand.
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
      db.prepare(`INSERT INTO runs (id, kind, role, idea_id, loop_id, session_id, status, purpose, prompt, task_type, started_at, owner_action)
        VALUES (?, 'factory', ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
        .run(id, opts.role, opts.ideaId || null, opts.loopId || null, `s-${n}`, opts.purpose, opts.prompt, opts.taskType || null, new Date().toISOString(), opts.ownerAction ? 1 : 0);
      active.add(id);
      started.push({ id, ...opts });
      return id;
    },
    resumeWith(runId, msgs) { return this.start({ role: db.prepare('SELECT role FROM runs WHERE id = ?').get(runId).role, purpose: 'resume', prompt: msgs[0].text, ideaId: db.prepare('SELECT idea_id FROM runs WHERE id = ?').get(runId).idea_id, resumed: runId }); },
    end(id, status = 'done', endedAt = new Date().toISOString()) {
      active.delete(id);
      db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run(status, endedAt, id);
    },
  };
}

test('inbox ideas go to one batched triage run', () => {
  const { db, cfg } = fixture();
  const runner = fakeRunner(db);
  for (let i = 0; i < 10; i += 1) createIdea(db, cfg, { title: `idea ${i}`, origin: 'owner' });
  dispatchTick(db, cfg, runner);
  assert.equal(runner.started.length, 1);
  assert.equal(runner.started[0].role, 'game-manager');
  assert.match(runner.started[0].prompt, /Idea #8:/);
  assert.doesNotMatch(runner.started[0].prompt, /Idea #9:/);
  dispatchTick(db, cfg, runner);
  assert.equal(runner.started.length, 1, 'no second triage while one is active');
});

test('stages route to design, builder and QA; one run per idea; concurrency respected', () => {
  const { db, cfg } = fixture();
  const runner = fakeRunner(db);
  const spec = createIdea(db, cfg, { title: 'Floor 3 race', origin: 'owner' });
  updateIdea(db, cfg, spec.id, { status: 'triaged', needs_spec: true, owner_role: 'engineering-lead' });
  const build = createIdea(db, cfg, { title: 'Book text', origin: 'owner' });
  updateIdea(db, cfg, build.id, { status: 'triaged', owner_role: 'narrative-director', task_type: 'story-text' });
  const qa = createIdea(db, cfg, { title: 'Canopy respawn', origin: 'owner' });
  updateIdea(db, cfg, qa.id, { status: 'qa', owner_role: 'engineering-lead' });
  const extra = createIdea(db, cfg, { title: 'Extra', origin: 'owner' });
  updateIdea(db, cfg, extra.id, { status: 'building', owner_role: 'balance-lead', priority: 3 });

  dispatchTick(db, cfg, runner);
  assert.equal(runner.started.length, 3);
  const byIdea = Object.fromEntries(runner.started.map((s) => [s.ideaId, s]));
  assert.equal(byIdea[spec.id].role, 'design-lead');
  assert.equal(byIdea[build.id].role, 'narrative-director');
  assert.equal(byIdea[build.id].taskType, 'story-text');
  assert.equal(byIdea[qa.id].role, 'qa-lead');
  assert.equal(db.prepare('SELECT status FROM ideas WHERE id = ?').get(spec.id).status, 'spec');
  dispatchTick(db, cfg, runner);
  assert.equal(runner.started.length, 3);
});

test('needs-approval ideas, paused factory and failed last runs are not dispatched', () => {
  const { db, cfg } = fixture();
  const runner = fakeRunner(db);
  const fresh = createIdea(db, cfg, { title: 'Endgame raid', origin: 'agent', kind: 'feature' });
  updateIdea(db, cfg, fresh.id, { status: 'triaged' });
  const ok = createIdea(db, cfg, { title: 'HUD fix', origin: 'qa', kind: 'bug' });
  updateIdea(db, cfg, ok.id, { status: 'building', owner_role: 'engineering-lead' });
  kvSet(db, 'paused', '1');
  assert.equal(dispatchTick(db, cfg, runner).reason, 'paused');
  kvSet(db, 'paused', '0');
  dispatchTick(db, cfg, runner);
  assert.deepEqual(runner.started.map((s) => s.ideaId), [ok.id]);
  runner.end(runner.started[0].id, 'failed');
  dispatchTick(db, cfg, runner);
  assert.equal(runner.started.length, 1);
});

test('budget blocks dispatch but not owner chat; stalled ideas back off and resume the same session', () => {
  const { db, cfg } = fixture();
  const runner = fakeRunner(db);
  const i = createIdea(db, cfg, { title: 'Snap attack', origin: 'owner' });
  updateIdea(db, cfg, i.id, { status: 'building', owner_role: 'engineering-lead' });
  dispatchTick(db, cfg, runner);
  const first = runner.started[0].id;
  runner.end(first, 'done', new Date(Date.now() - 60_000).toISOString());
  dispatchTick(db, cfg, runner);
  assert.equal(runner.started.length, 1, 'backs off for 5 minutes after a run that did not move the idea');
  dispatchTick(db, cfg, runner, Date.now() + 6 * 60_000);
  assert.equal(runner.started.length, 2);
  assert.equal(runner.started[1].resumed, first);

  db.prepare("INSERT INTO runs (id, kind, role, status, started_at, input_tokens) VALUES ('big', 'factory', 'qa-lead', 'done', ?, ?)")
    .run(new Date().toISOString(), cfg.guards.dailyTokenBudget);
  assert.equal(budgetState(db, cfg).exhausted, true);
  runner.end(runner.started[1].id);
  assert.equal(dispatchTick(db, cfg, runner, Date.now() + 60 * 60_000).reason, 'budget');
});

test('too many runs puts the idea on hold with a question', () => {
  const { db, cfg } = fixture();
  const runner = fakeRunner(db);
  const i = createIdea(db, cfg, { title: 'Hard thing', origin: 'owner' });
  updateIdea(db, cfg, i.id, { status: 'building', owner_role: 'engineering-lead' });
  for (let k = 0; k < cfg.guards.maxRunsPerIdea; k += 1) {
    db.prepare("INSERT INTO runs (id, kind, role, idea_id, status, started_at, ended_at) VALUES (?, 'factory', 'engineering-lead', ?, 'done', ?, ?)")
      .run(`old-${k}`, i.id, new Date(Date.now() - 86400_000).toISOString(), new Date(Date.now() - 86400_000).toISOString());
  }
  dispatchTick(db, cfg, runner);
  assert.equal(db.prepare('SELECT status FROM ideas WHERE id = ?').get(i.id).status, 'on_hold');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM questions WHERE idea_id = ? AND status = 'open'").get(i.id).n, 1);
});

test('scheduler: fires once per slot, skips disabled, catches up recent misses only', () => {
  const { db, cfg } = fixture();
  const runner = fakeRunner(db);
  const nine = new Date(); nine.setHours(9, 0, 30, 0);
  cfg.guards.catchUpHours = 8;
  cfg.loops = cfg.loops.filter((l) => ['morning-triage', 'nightly-qa', 'checkpoint'].includes(l.id));
  initLoops(db, cfg);
  db.prepare('UPDATE loop_state SET last_fired_at = ?').run(new Date(nine.getTime() - 2 * 86400_000).toISOString());
  const fired = schedulerTick(db, cfg, runner, nine);
  const loops = runner.started.map((s) => s.loopId);
  assert.ok(loops.includes('morning-triage'));
  assert.ok(loops.includes('nightly-qa'), '02:00 slot missed 7h ago is caught up');
  assert.ok(!loops.includes('checkpoint'), '23:30 slot is 9.5h old, beyond catchUpHours');
  for (const id of fired) runner.end(id);
  const before = runner.started.length;
  schedulerTick(db, cfg, runner, new Date(nine.getTime() + 60_000));
  assert.equal(runner.started.length, before, 'same slot does not fire twice');
  setEnabled(db, 'morning-triage', false);
  assert.equal(loopView(db, cfg, nine).find((l) => l.id === 'morning-triage').enabled, false);
});
