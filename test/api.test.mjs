import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../lib/api.mjs';
import { askOwner } from '../lib/questions.mjs';
import { fixture } from './helpers.mjs';

async function boot() {
  const { db, cfg } = fixture();
  const runner = { activeCount: () => 0, isActive: () => false, answer: (id, a) => { db.prepare("UPDATE questions SET status = 'answered', answer = ? WHERE id = ?").run(a, id); return { done: 'answered' }; } };
  const server = createApi({ db, getCfg: () => cfg, runner, secret: 'tok', port: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // The API checks Host against its configured port; rebuild with the real one.
  server.close();
  const real = createApi({ db, getCfg: () => cfg, runner, secret: 'tok', port });
  await new Promise((r) => real.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  const call = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { db, cfg, server: real, call, base };
}

test('mutations need the token and a same-origin Origin', async () => {
  const { server, call, base } = await boot();
  try {
    assert.equal((await call('POST', '/api/ideas', { title: 'x' })).status, 403);
    assert.equal((await call('POST', '/api/ideas', { title: 'x' }, { 'x-factory-token': 'tok', origin: 'https://evil.example' })).status, 403);
    const ok = await call('POST', '/api/ideas', { title: 'Daily fish bonus', area: 'Economy' }, { 'x-factory-token': 'tok', origin: base });
    assert.equal(ok.status, 200);
    const home = await (await call('GET', '/api/home')).json();
    assert.equal(home.ideas.length, 1, "the dashboard creates a high-level idea");
    assert.equal(home.ideas[0].status, "active");
    assert.equal(home.tools.resources.length, 4);
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /tok/);
  } finally { server.close(); }
});

test('answering a question and listing ideas by stage', async () => {
  const { db, server, call } = await boot();
  try {
    const qid = askOwner(db, { role: 'combat', runId: null }, { question: '0.6s or 0.9s?', choices: ['0.6s', '0.9s'] });
    const r = await call('POST', `/api/questions/${qid}/answer`, { answer: '0.9s' }, { 'x-factory-token': 'tok' });
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT status FROM questions WHERE id = ?').get(qid).status, 'answered');
    const list = await (await call('GET', '/api/ideas?group=active')).json();
    assert.ok(Array.isArray(list.ideas));
    assert.equal((await call('GET', '/api/nope')).status, 404);
  } finally { server.close(); }
});
