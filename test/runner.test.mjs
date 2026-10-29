import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.mjs';
import { Runner, recoverOrphans } from '../lib/runner.mjs';
import { createIdea } from '../lib/ideas.mjs';
import { rate, modelFor } from '../lib/routing.mjs';
import { claim } from '../lib/resources.mjs';
import { FACTORY_DIR } from '../lib/paths.mjs';
import { fixture } from './helpers.mjs';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-run-'));
  process.env.FACTORY_DB = path.join(dir, 'f.db');
  process.env.FAKE_ARGS_LOG = path.join(dir, 'args.jsonl');
  const db = openDb(process.env.FACTORY_DB);
  const { cfg } = fixture();
  cfg.settings.claudePath = path.join(FACTORY_DIR, 'test', 'fake-claude.mjs');
  const ended = [];
  const runner = new Runner(db, cfg, { onEvent: (e) => { if (e.type === 'run-end') ended.push(e); } });
  const waitEnd = async (n) => { for (let i = 0; i < 200 && ended.length < n; i += 1) await new Promise((r) => setTimeout(r, 25)); };
  const argsLog = () => fs.readFileSync(process.env.FAKE_ARGS_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  return { db, cfg, runner, waitEnd, argsLog, ended };
}

test('a run goes running → done with tokens, summary, routed model and released tools', async () => {
  const { db, cfg, runner, waitEnd, argsLog } = setup();
  const idea = createIdea(db, cfg, { title: 'Book text', origin: 'owner' });
  const id = runner.start({ role: 'narrative-director', purpose: 'write book text', prompt: 'hello', ideaId: idea.id, taskType: 'story-text' });
  claim(db, cfg, 'git', { key: `run:${id}`, runId: id, role: 'narrative-director' });
  await waitEnd(1);
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  assert.equal(run.status, 'done');
  assert.equal(run.model, 'haiku');
  assert.equal(run.input_tokens + run.output_tokens + run.cache_write, 330);
  assert.match(run.result_text, /done: hello/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM holds WHERE released_at IS NULL').get().n, 0);
  const a = argsLog()[0].args;
  assert.ok(a.includes('--agent') && a[a.indexOf('--agent') + 1] === 'ct-narrative-director');
  assert.ok(a.includes('--permission-prompts') && a.includes('--session-id'));
  assert.ok(db.prepare("SELECT COUNT(*) n FROM activity WHERE run_id = ? AND kind = 'text'").get(id).n >= 1);
});

test('blocking question parks the run; answering resumes the same session', async () => {
  const { db, runner, waitEnd, argsLog } = setup();
  const id = runner.start({ role: 'engineering-lead', purpose: 'snap attack', prompt: 'ASK please' });
  await waitEnd(1);
  assert.equal(db.prepare('SELECT status FROM runs WHERE id = ?').get(id).status, 'parked');
  const q = db.prepare("SELECT * FROM questions WHERE run_id = ?").get(id);
  const res = runner.answer(q.id, '0.9s');
  assert.ok(res.resumed);
  await waitEnd(2);
  const resumed = db.prepare('SELECT * FROM runs WHERE id = ?').get(res.resumed);
  assert.equal(resumed.resumed_from, id);
  assert.equal(resumed.status, 'done');
  const last = argsLog().at(-1);
  assert.equal(last.args[last.args.indexOf('--resume') + 1], db.prepare('SELECT session_id FROM runs WHERE id = ?').get(id).session_id);
  assert.match(last.prompt, /Owner answered your question #\d+.*0\.9s/s);
  assert.equal(db.prepare('SELECT status FROM runs WHERE id = ?').get(id).status, 'resumed');
});

test('answer while running is queued, then resumes when the run exits without seeing it', async () => {
  const { db, runner, waitEnd } = setup();
  const id = runner.start({ role: 'balance-lead', purpose: 'tune', prompt: 'SLOW' });
  db.prepare("INSERT INTO questions (run_id, role, kind, text, blocking, created_at) VALUES (?, 'balance-lead', 'question', 'HP?', 0, ?)").run(id, new Date().toISOString());
  const q = db.prepare('SELECT id FROM questions WHERE run_id = ?').get(id);
  assert.deepEqual(runner.answer(q.id, '1100'), { queued: true });
  await waitEnd(2);
  const runs = db.prepare('SELECT * FROM runs ORDER BY started_at').all();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].resumed_from, id);
});

test('failed run files a failure question; Retry starts it again', async () => {
  const { db, runner, waitEnd } = setup();
  const id = runner.start({ role: 'qa-lead', purpose: 'regression', prompt: 'FAIL now' });
  await waitEnd(1);
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /boom/);
  const q = db.prepare("SELECT * FROM questions WHERE kind = 'failure'").get();
  assert.ok(runner.answer(q.id, 'Retry').retried);
  await waitEnd(2);
});

test('owner chat starts a fresh run, then resumes that session next time', async () => {
  const { db, runner, waitEnd } = setup();
  const first = runner.chat('design-lead', 'what is next for Floor 3?');
  assert.equal(first.delivered, 'new');
  await waitEnd(1);
  const reply = db.prepare("SELECT * FROM messages WHERE kind = 'reply'").get();
  assert.equal(reply.from_role, 'design-lead');
  const second = runner.chat('design-lead', 'ok do it');
  assert.equal(second.delivered, 'resumed');
  await waitEnd(2);
});

test('recoverOrphans fails stale running rows and frees their tools', () => {
  const { db, cfg } = fixture();
  db.prepare("INSERT INTO runs (id, kind, role, status, started_at) VALUES ('f-old', 'factory', 'qa-lead', 'running', ?)").run(new Date().toISOString());
  claim(db, cfg, 'studio', { key: 'run:f-old', runId: 'f-old', role: 'qa-lead' });
  assert.equal(recoverOrphans(db), 1);
  assert.equal(db.prepare("SELECT status FROM runs WHERE id = 'f-old'").get().status, 'failed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM holds WHERE released_at IS NULL').get().n, 0);
});

test('learning rule: two "model too weak" redos move blender-mesh up a tier', () => {
  const { db, cfg } = fixture();
  cfg.routing['blender-mesh'].model = 'sonnet';
  for (const id of ['a', 'b', 'c']) {
    db.prepare(`INSERT INTO runs (id, kind, role, model, task_type, status, started_at)
      VALUES (?, 'factory', 'art-director', 'sonnet', 'blender-mesh', 'done', ?)`).run(id, new Date().toISOString());
  }
  assert.equal(rate(db, cfg, { runId: 'a', verdict: 'redo', reason: 'model', note: 'claws wrong scale' }).bumped, null);
  rate(db, cfg, { runId: 'b', verdict: 'good' });
  const r = rate(db, cfg, { runId: 'c', verdict: 'redo', reason: 'model' });
  assert.deepEqual([r.bumped.from, r.bumped.to], ['sonnet', 'opus']);
  assert.equal(modelFor(db, cfg, { role: 'art-director', taskType: 'blender-mesh' }).model, 'opus');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM improvements WHERE kind = 'routing'").get().n, 1);
});
