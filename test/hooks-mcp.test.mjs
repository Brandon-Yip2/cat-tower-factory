import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { handleHook } from '../lib/hookcore.mjs';
import { claim } from '../lib/resources.mjs';
import { createIdea } from '../lib/ideas.mjs';
import { sendMessage } from '../lib/questions.mjs';
import { openDb } from '../lib/db.mjs';
import { FACTORY_DIR } from '../lib/paths.mjs';
import { fixture } from './helpers.mjs';

function factoryRun(db, id, role, ideaId = null) {
  db.prepare(`INSERT INTO runs (id, kind, role, idea_id, status, purpose, started_at)
    VALUES (?, 'factory', ?, ?, 'running', ?, ?)`).run(id, role, ideaId, `${role} work`, new Date().toISOString());
}

test('SessionStart injects the snapshot and pending messages', () => {
  const { db, cfg } = fixture();
  const idea = createIdea(db, cfg, { title: 'Old Gnaw snap attack', origin: 'owner' });
  factoryRun(db, 'f-1', 'engineering-lead', idea.id);
  sendMessage(db, { from: 'owner', to: 'engineering-lead', text: 'use 0.9s telegraph' });
  const out = handleHook(db, cfg, 'SessionStart', { session_id: 's1', transcript_path: 't.jsonl', source: 'startup' }, { FACTORY_RUN_ID: 'f-1' });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /FACTORY NOW/);
  assert.match(ctx, /Your idea: #1 "Old Gnaw snap attack"/);
  assert.match(ctx, /use 0.9s telegraph/);
  assert.equal(db.prepare('SELECT session_id FROM runs WHERE id = ?').get('f-1').session_id, 's1');
});

test('PreToolUse denies a factory run when Studio is held, never blocks the owner', () => {
  const { db, cfg } = fixture();
  factoryRun(db, 'f-qa', 'qa-lead');
  factoryRun(db, 'f-art', 'art-director');
  const studioCall = { session_id: 's-art', tool_name: 'mcp__Roblox_Studio__execute_luau', tool_input: { code: 'print(1)' } };
  assert.equal(handleHook(db, cfg, 'PreToolUse', { ...studioCall, session_id: 's-qa' }, { FACTORY_RUN_ID: 'f-qa' }), null);
  const denied = handleHook(db, cfg, 'PreToolUse', studioCall, { FACTORY_RUN_ID: 'f-art' });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Head of QA/);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /#1 in its queue/);
  // Owner's interactive session: allowed, then warned after the call.
  assert.equal(handleHook(db, cfg, 'PreToolUse', { ...studioCall, session_id: 'owner-1' }, {}), null);
  const post = handleHook(db, cfg, 'PostToolUse', { ...studioCall, session_id: 'owner-1', tool_response: {} }, {});
  assert.match(post.hookSpecificOutput.additionalContext, /also held by Head of QA/);
});

test('protected Factory files cannot be edited by factory runs', () => {
  const { db, cfg } = fixture();
  factoryRun(db, 'f-fe', 'factory-engineer');
  const out = handleHook(db, cfg, 'PreToolUse', { session_id: 's', tool_name: 'Edit', tool_input: { file_path: path.join(FACTORY_DIR, 'guards.json') } }, { FACTORY_RUN_ID: 'f-fe' });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const ok = handleHook(db, cfg, 'PreToolUse', { session_id: 's', tool_name: 'Edit', tool_input: { file_path: path.join(FACTORY_DIR, 'factory.config.json') } }, { FACTORY_RUN_ID: 'f-fe' });
  assert.equal(ok, null);
});

test('PostToolUse logs files and delivers an owner message once; answer while running is queued', () => {
  const { db, cfg } = fixture();
  factoryRun(db, 'f-1', 'balance-lead');
  const input = { session_id: 's', tool_name: 'Edit', tool_input: { file_path: 'place/scripts/Config.luau' }, tool_response: {} };
  assert.equal(handleHook(db, cfg, 'PostToolUse', input, { FACTORY_RUN_ID: 'f-1' }), null);
  sendMessage(db, { from: 'owner', to: 'balance-lead', runId: 'f-1', text: 'Owner answered question #3: 1100 HP', kind: 'answer' });
  const first = handleHook(db, cfg, 'PostToolUse', input, { FACTORY_RUN_ID: 'f-1' });
  assert.match(first.hookSpecificOutput.additionalContext, /1100 HP/);
  assert.equal(handleHook(db, cfg, 'PostToolUse', input, { FACTORY_RUN_ID: 'f-1' }), null);
  const files = db.prepare("SELECT files FROM activity WHERE kind = 'file'").all();
  assert.equal(JSON.parse(files[0].files)[0], 'place/scripts/Config.luau');
});

test('SessionEnd releases everything the session held', () => {
  const { db, cfg } = fixture();
  handleHook(db, cfg, 'PreToolUse', { session_id: 'x', tool_name: 'Bash', tool_input: { command: 'git commit -m a' } }, {});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM holds WHERE released_at IS NULL').get().n, 1);
  handleHook(db, cfg, 'SessionEnd', { session_id: 'x', reason: 'exit' }, {});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM holds WHERE released_at IS NULL').get().n, 0);
  assert.equal(db.prepare("SELECT status FROM runs WHERE id = 'i-x'").get().status, 'ended');
});

test('hook CLI fails open when the DB cannot be opened', () => {
  const r = spawnSync(process.execPath, [path.join(FACTORY_DIR, 'hooks', 'hook.mjs'), 'PreToolUse'], {
    input: JSON.stringify({ session_id: 'z', tool_name: 'Bash', tool_input: { command: 'git commit' } }),
    env: { ...process.env, FACTORY_DB: path.join(FACTORY_DIR, 'guards.json', 'no', 'db.sqlite') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('MCP server: initialize, list tools, approval rule surfaces as a tool error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-mcp-'));
  const dbPath = path.join(dir, 'f.db');
  const { cfg } = fixture();
  const db = openDb(dbPath);
  const idea = createIdea(db, cfg, { title: 'Endgame raid', origin: 'agent', kind: 'feature' });
  db.close();
  const child = spawn(process.execPath, [path.join(FACTORY_DIR, 'mcp', 'server.mjs')], { env: { ...process.env, FACTORY_DB: dbPath } });
  const replies = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_idea', arguments: { id: idea.id, status: 'building' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'factory_status', arguments: {} } });
  for (let t = 0; t < 100 && replies.length < 4; t += 1) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end();
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.equal(byId[1].result.serverInfo.name, 'factory');
  assert.ok(byId[2].result.tools.some((t) => t.name === 'ask_owner'));
  assert.equal(byId[3].result.isError, true);
  assert.match(byId[3].result.content[0].text, /approval/);
  assert.match(byId[4].result.content[0].text, /FACTORY NOW/);
});
