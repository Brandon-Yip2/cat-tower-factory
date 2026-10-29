// Regression tests for the findings of the 2026-10-29 branch review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdea, updateIdea, ApprovalError } from '../lib/ideas.mjs';
import { claim, release } from '../lib/resources.mjs';
import { handleHook } from '../lib/hookcore.mjs';
import { identifyForMcp } from '../lib/identity.mjs';
import { dispatchTick } from '../lib/dispatcher.mjs';
import { Runner } from '../lib/runner.mjs';
import { openDb } from '../lib/db.mjs';
import { FACTORY_DIR } from '../lib/paths.mjs';
import { fixture } from './helpers.mjs';

test('needs_owner is sticky: relabelling the kind or pointing at an agent idea does not approve it', () => {
  const { db, cfg } = fixture();
  const owner = createIdea(db, cfg, { title: 'Owner idea', origin: 'owner' });
  const agentIdea = createIdea(db, cfg, { title: 'Agent bug', origin: 'agent', kind: 'bug' });
  const raid = createIdea(db, cfg, { title: 'Raid mode', origin: 'agent', kind: 'feature' });
  assert.equal(updateIdea(db, cfg, raid.id, { kind: 'tech', status: 'triaged' }, 'game-manager').status, 'needs_approval');
  assert.throws(() => updateIdea(db, cfg, raid.id, { parent_id: agentIdea.id }, 'game-manager'), ApprovalError);
  assert.throws(() => updateIdea(db, cfg, raid.id, { parent_id: 9999 }, 'game-manager'), ApprovalError);
  assert.throws(() => createIdea(db, cfg, { title: 'x', origin: 'agent', parentId: agentIdea.id }), ApprovalError);
  assert.equal(updateIdea(db, cfg, raid.id, { parent_id: owner.id }, 'game-manager').approval, 'approved');
  // Triage can still escalate a mislabelled agent idea to the owner.
  const sneaky = createIdea(db, cfg, { title: 'Whole new mode', origin: 'agent', kind: 'tech' });
  assert.equal(updateIdea(db, cfg, sneaky.id, { kind: 'feature', status: 'triaged' }, 'game-manager').status, 'needs_approval');
});

function factoryRun(db, id, role) {
  db.prepare("INSERT INTO runs (id, kind, role, status, started_at) VALUES (?, 'factory', ?, 'running', ?)").run(id, role, new Date().toISOString());
}

test('protected paths: case and dot variants, more directories, and shell writes', () => {
  const { db, cfg } = fixture();
  factoryRun(db, 'f-fe', 'factory-engineer');
  const pre = (tool_name, tool_input) => handleHook(db, cfg, 'PreToolUse', { session_id: 's', tool_name, tool_input }, { FACTORY_RUN_ID: 'f-fe' });
  const denied = (o) => o?.hookSpecificOutput?.permissionDecision === 'deny';
  if (process.platform === 'win32') assert.ok(denied(pre('Write', { file_path: 'factory/Guards.json' })));
  assert.ok(denied(pre('Edit', { file_path: 'factory/./lib/db.mjs' })));
  assert.ok(denied(pre('Edit', { file_path: path.join(FACTORY_DIR, 'mcp', 'server.mjs') })));
  assert.ok(denied(pre('Edit', { file_path: path.join(FACTORY_DIR, 'ui', 'app.js') })));
  assert.ok(denied(pre('Bash', { command: "node -e \"require('fs').writeFileSync('factory/guards.json','{}')\"" })));
  assert.ok(denied(pre('PowerShell', { command: 'Set-Content factory/guards.json "{}"' })));
  assert.equal(pre('Bash', { command: 'node --test factory/test/*.test.mjs 2>&1 | tail -5' }), null);
  assert.equal(pre('Bash', { command: 'cat factory/guards.json' }), null);
  assert.equal(pre('Edit', { file_path: path.join(FACTORY_DIR, 'prompts', 'triage.md') }), null);
});

test('the owner session never queues, so it never reserves a tool against agents', () => {
  const { db, cfg } = fixture();
  factoryRun(db, 'a', 'qa-lead');
  factoryRun(db, 'b', 'art-director');
  assert.equal(claim(db, cfg, 'studio', { key: 'run:a', kind: 'factory', runId: 'a', role: 'qa-lead' }).ok, true);
  assert.equal(claim(db, cfg, 'studio', { key: 'session:me', kind: 'interactive', sessionId: 'me', role: 'owner-session' }).ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM queue').get().n, 0);
  release(db, 'studio', 'run:a');
  assert.equal(claim(db, cfg, 'studio', { key: 'run:b', kind: 'factory', runId: 'b', role: 'art-director' }).ok, true);
});

test('MCP calls from an interactive subagent are attributed to that subagent, not the owner', () => {
  const { db, cfg } = fixture();
  handleHook(db, cfg, 'PreToolUse', { session_id: 'sess-1', agent_type: 'ct-qa-lead', agent_id: 'ag1', tool_name: 'mcp__factory__propose_idea', tool_input: {} }, {});
  const who = identifyForMcp(db, cfg, {});
  assert.equal(who.role, 'qa-lead');
  assert.equal(who.sessionId, 'sess-1');
});

function fakeRunner(db) {
  const started = [];
  return { started, activeCount: () => 0, isActive: () => false, start(o) { started.push(o); return `f-${started.length}`; }, resumeWith() { return 'r'; } };
}

test('taking an idea off hold resets its run allowance; stopped runs wait for the owner', () => {
  const { db, cfg } = fixture();
  const runner = fakeRunner(db);
  const i = createIdea(db, cfg, { title: 'Hard thing', origin: 'owner' });
  updateIdea(db, cfg, i.id, { status: 'building', owner_role: 'engineering-lead' });
  const old = new Date(Date.now() - 86400_000).toISOString();
  for (let k = 0; k < cfg.guards.maxRunsPerIdea; k += 1) {
    db.prepare("INSERT INTO runs (id, kind, role, idea_id, status, started_at, ended_at) VALUES (?, 'factory', 'engineering-lead', ?, 'done', ?, ?)").run(`o${k}`, i.id, old, old);
  }
  dispatchTick(db, cfg, runner);
  assert.equal(db.prepare('SELECT status FROM ideas WHERE id = ?').get(i.id).status, 'on_hold');
  const q = db.prepare("SELECT * FROM questions WHERE idea_id = ? AND kind = 'hold'").get(i.id);
  assert.ok(q);
  const r = new Runner(db, cfg);
  r.answer(q.id, 'Try again');
  assert.equal(db.prepare('SELECT status FROM ideas WHERE id = ?').get(i.id).status, 'triaged');
  dispatchTick(db, cfg, runner);
  assert.equal(runner.started.length, 1, 'dispatched again after the reset');

  db.prepare("INSERT INTO runs (id, kind, role, idea_id, status, started_at, ended_at) VALUES ('stp', 'factory', 'engineering-lead', ?, 'stopped', ?, ?)")
    .run(i.id, new Date(Date.now() + 1000).toISOString(), new Date(Date.now() + 1000).toISOString());
  dispatchTick(db, cfg, runner, Date.now() + 2 * 3600_000);
  assert.equal(runner.started.length, 1, 'a stopped run is not retried automatically');
});

test('answering the second of two questions reaches the newest run of the session, not a second resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-chain-'));
  process.env.FACTORY_DB = path.join(dir, 'f.db');
  const db = openDb(process.env.FACTORY_DB);
  const { cfg } = fixture();
  cfg.settings.claudePath = path.join(FACTORY_DIR, 'test', 'fake-claude.mjs');
  let ended = 0;
  const runner = new Runner(db, cfg, { onEvent: (e) => { if (e.type === 'run-end') ended += 1; } });
  const wait = async (n) => { for (let k = 0; k < 200 && ended < n; k += 1) await new Promise((r) => setTimeout(r, 25)); };
  const a = runner.start({ role: 'engineering-lead', purpose: 'two questions', prompt: 'ASK' });
  await wait(1);
  db.prepare("INSERT INTO questions (run_id, role, kind, text, blocking, created_at) VALUES (?, 'engineering-lead', 'question', 'Second?', 1, ?)").run(a, new Date().toISOString());
  const [q1, q2] = db.prepare('SELECT id FROM questions WHERE run_id = ? ORDER BY id').all(a).map((x) => x.id);
  const first = runner.answer(q1, 'yes');
  assert.ok(first.resumed);
  const second = runner.answer(q2, 'also yes');
  assert.deepEqual(second, { queued: true });
  assert.equal(db.prepare("SELECT run_id FROM messages WHERE kind = 'answer' ORDER BY id DESC LIMIT 1").get().run_id, first.resumed);
  await wait(3);
  const live = db.prepare("SELECT COUNT(*) n FROM runs WHERE status = 'running'").get().n;
  assert.equal(live, 0);
});

test('stopping a run puts its idea on hold', () => {
  const { db, cfg } = fixture();
  const i = createIdea(db, cfg, { title: 'Snap', origin: 'owner' });
  updateIdea(db, cfg, i.id, { status: 'building', owner_role: 'engineering-lead' });
  db.prepare("INSERT INTO runs (id, kind, role, idea_id, status, started_at) VALUES ('s1', 'factory', 'engineering-lead', ?, 'running', ?)").run(i.id, new Date().toISOString());
  new Runner(db, cfg).stop('s1');
  assert.equal(db.prepare('SELECT status FROM ideas WHERE id = ?').get(i.id).status, 'on_hold');
});
