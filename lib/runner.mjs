// Starts, watches, parks and resumes headless Claude Code runs (`claude -p --agent ct-…`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { now, newId, logActivity } from './db.mjs';
import { roleById } from './config.mjs';
import { REPO_ROOT, DATA_DIR, PROMPTS_DIR, FACTORY_DIR } from './paths.mjs';
import { releaseAll } from './resources.mjs';
import { modelFor } from './routing.mjs';
import { addIdeaEvent, decideApproval, updateIdea } from './ideas.mjs';
import { sendMessage } from './questions.mjs';
import { resolveClaude } from './claude-path.mjs';
import { chatPrompt, resumePrompt } from './stages.mjs';

const tierOf = (model) => (/opus/i.test(model) ? 'opus' : /haiku/i.test(model) ? 'haiku' : 'sonnet');

function runtimeMcpConfig() {
  const file = path.join(DATA_DIR, 'mcp.runtime.json');
  const cfg = { mcpServers: { factory: { type: 'stdio', command: process.execPath, args: [path.join(FACTORY_DIR, 'mcp', 'server.mjs')] } } };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch { /* already gone */ }
}

// True only if `pid` is still the Claude Code process this run started: it must have started
// after the last boot (pids are reused across reboots) and still be a claude executable.
function stillOurClaude(run) {
  if (!run.pid) return false;
  const bootedAt = Date.now() - os.uptime() * 1000;
  if (Date.parse(run.started_at) < bootedAt) return false;
  try { process.kill(run.pid, 0); } catch { return false; }
  if (process.platform !== 'win32') return true;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${run.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /^"claude/i.test((r.stdout || '').trim());
}

// Daemon restarted: any run still marked running has no reader for its output any more.
export function recoverOrphans(db) {
  const rows = db.prepare("SELECT * FROM runs WHERE kind = 'factory' AND status = 'running'").all();
  for (const r of rows) {
    if (stillOurClaude(r)) killTree(r.pid);
    db.prepare("UPDATE runs SET status = 'failed', error = 'orphaned: the Factory restarted during this run', ended_at = ? WHERE id = ?")
      .run(now(), r.id);
    releaseAll(db, `run:${r.id}`, 'run orphaned');
  }
  return rows.length;
}

export class Runner {
  constructor(db, cfg, { onEvent = () => {}, spawnImpl = spawn } = {}) {
    this.db = db;
    this.cfg = cfg;
    this.onEvent = onEvent;
    this.spawnImpl = spawnImpl;
    this.procs = new Map();
    this.mcpConfig = null;
  }

  setConfig(cfg) { this.cfg = cfg; }

  activeCount() { return this.procs.size; }

  isActive(runId) { return this.procs.has(runId); }

  preamble(runId, role, purpose) {
    const tpl = fs.readFileSync(path.join(PROMPTS_DIR, 'preamble.md'), 'utf8');
    return tpl.replaceAll('{{RUN_ID}}', runId).replaceAll('{{ROLE}}', role).replaceAll('{{PURPOSE}}', purpose);
  }

  // opts: { role, purpose, prompt, ideaId?, loopId?, taskType?, model?, resumeSessionId?, resumedFrom?, chat?, ownerAction? }
  start(opts) {
    const role = roleById(this.cfg, opts.role);
    if (!role) throw new Error(`unknown role "${opts.role}"`);
    const routed = opts.model ? { model: opts.model, why: opts.modelWhy || 'set for this run' } : modelFor(this.db, this.cfg, { role: role.id, taskType: opts.taskType });
    const claude = resolveClaude(this.cfg); // throws before anything is recorded if Claude Code is missing
    const id = newId('f');
    const sessionId = opts.resumeSessionId || crypto.randomUUID();
    const t = now();
    this.db.prepare(`INSERT INTO runs (id, kind, role, agent_type, idea_id, loop_id, session_id, resumed_from, model, model_why,
        task_type, status, purpose, prompt, started_at, last_activity_at, owner_action)
      VALUES (?, 'factory', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
      .run(id, role.id, role.agent, opts.ideaId || null, opts.loopId || null, sessionId, opts.resumedFrom || null,
        routed.model, routed.why, opts.taskType || null, opts.purpose, opts.prompt, t, t, opts.ownerAction ? 1 : 0);
    if (opts.ideaId) addIdeaEvent(this.db, opts.ideaId, role.id, 'run', `${opts.resumedFrom ? 'resumed' : 'started'} ${id} on ${routed.model}: ${opts.purpose}`);

    this.mcpConfig ||= runtimeMcpConfig();
    const cap = this.cfg.guards.runCapUsd[tierOf(routed.model)] ?? 8;
    const args = ['-p', '--agent', role.agent, '--model', routed.model,
      '--permission-mode', 'auto', '--permission-prompts', 'none',
      '--output-format', 'stream-json', '--verbose',
      '--mcp-config', this.mcpConfig,
      '--append-system-prompt', this.preamble(id, role.id, opts.purpose),
      '--max-budget-usd', String(cap),
      '-n', `${role.name}: ${opts.purpose}`.slice(0, 80)];
    args.push(...(opts.resumeSessionId ? ['--resume', sessionId] : ['--session-id', sessionId]));

    const env = { ...process.env, FACTORY_RUN_ID: id, FACTORY_ROLE: role.id };
    const author = this.cfg.settings.gitAuthor;
    if (author?.name) Object.assign(env, { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email });
    const child = this.spawnImpl(claude.cmd, [...claude.prefix, ...args], {
      cwd: REPO_ROOT, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(child.pid || null, id);
    const state = { child, buf: '', stderr: '', result: null, lastText: '', opts: { ...opts, role: role.id } };
    this.procs.set(id, state);
    child.stdout.on('data', (d) => this.onStdout(id, state, d));
    child.stderr.on('data', (d) => { state.stderr = (state.stderr + d).slice(-4000); });
    child.on('error', (err) => { state.stderr += `\n${err.message}`; });
    child.on('close', (code) => this.finish(id, state, code));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.prompt);
    logActivity(this.db, { runId: id, role: role.id, kind: 'status', summary: `${opts.resumedFrom ? 'resumed' : 'started'} on ${routed.model}: ${opts.purpose}` });
    this.onEvent({ type: 'run-start', runId: id });
    return id;
  }

  onStdout(id, state, data) {
    state.buf += data;
    let i;
    while ((i = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, i).trim();
      state.buf = state.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.handleMessage(id, state, msg);
    }
  }

  handleMessage(id, state, msg) {
    const db = this.db;
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      db.prepare('UPDATE runs SET session_id = ? WHERE id = ?').run(msg.session_id, id);
    } else if (msg.type === 'system' && msg.subtype === 'post_turn_summary' && msg.status_detail) {
      db.prepare('UPDATE runs SET progress_note = ?, last_activity_at = ? WHERE id = ?').run(String(msg.status_detail).slice(0, 200), now(), id);
    } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      for (const block of msg.message?.content || []) {
        if (block.type === 'text' && block.text?.trim()) {
          state.lastText = block.text.trim();
          logActivity(db, { runId: id, role: state.opts.role, kind: 'text', summary: state.lastText.slice(0, 300) });
        }
      }
      db.prepare('UPDATE runs SET last_activity_at = ? WHERE id = ?').run(now(), id);
    } else if (msg.type === 'result') {
      state.result = msg;
    }
  }

  finish(id, state, code) {
    if (state.buf.trim()) this.onStdout(id, state, '\n');
    this.procs.delete(id);
    const db = this.db;
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    const r = state.result;
    let tokens = { in: 0, out: 0, cr: 0, cw: 0, cost: 0 };
    if (r?.modelUsage) {
      for (const u of Object.values(r.modelUsage)) {
        tokens.in += u.inputTokens || 0; tokens.out += u.outputTokens || 0;
        tokens.cr += u.cacheReadInputTokens || 0; tokens.cw += u.cacheCreationInputTokens || 0; tokens.cost += u.costUSD || 0;
      }
    } else if (r?.usage) {
      tokens = { in: r.usage.input_tokens || 0, out: r.usage.output_tokens || 0, cr: r.usage.cache_read_input_tokens || 0,
        cw: r.usage.cache_creation_input_tokens || 0, cost: r.total_cost_usd || 0 };
    }
    const stopped = run.status === 'stopped';
    const openQ = db.prepare("SELECT COUNT(*) n FROM questions WHERE run_id = ? AND status = 'open' AND blocking = 1").get(id).n;
    let status = 'done';
    let error = null;
    if (stopped) status = 'stopped';
    else if (!r) { status = 'failed'; error = `exited with code ${code}: ${state.stderr.trim().split('\n').slice(-3).join(' ')}`.slice(0, 600); }
    else if (r.is_error) { status = 'failed'; error = `${r.subtype || 'error'}: ${String(r.result || '').slice(0, 400)}`; }
    if (openQ && status !== 'stopped') status = 'parked';
    const resultText = String(r?.result || state.lastText || '').slice(0, 4000);
    db.prepare(`UPDATE runs SET status = ?, error = ?, result_text = ?, ended_at = ?, num_turns = ?, input_tokens = ?, output_tokens = ?,
        cache_read = ?, cache_write = ?, cost_usd = ?, session_id = COALESCE(?, session_id), progress = CASE WHEN ? = 'done' THEN 100 ELSE progress END
      WHERE id = ?`)
      .run(status, error, resultText, now(), r?.num_turns ?? null, tokens.in, tokens.out, tokens.cr, tokens.cw, tokens.cost,
        r?.session_id || null, status, id);
    releaseAll(db, `run:${id}`, status === 'parked' ? 'parked: waiting on owner' : `run ${status}`);
    logActivity(db, { runId: id, role: run.role, kind: 'status', summary: `${status}${error ? `: ${error}` : ''}` });

    if (run.idea_id) addIdeaEvent(db, run.idea_id, run.role, 'run', `${id} ${status}${resultText ? `: ${resultText.slice(0, 600)}` : ''}`);
    if (run.loop_id) {
      db.prepare('UPDATE loop_state SET last_status = ?, last_summary = ? WHERE loop_id = ? AND last_run_id = ?')
        .run(status, resultText.slice(0, 500), run.loop_id, id);
    }
    if (state.opts.chat && resultText) sendMessage(db, { from: run.role, to: 'owner', text: resultText, runId: id, kind: 'reply' });
    if (status === 'failed') {
      db.prepare(`INSERT INTO questions (run_id, role, idea_id, kind, text, choices, blocking, created_at)
        VALUES (?, ?, ?, 'failure', ?, ?, 0, ?)`)
        .run(id, run.role, run.idea_id, `${roleById(this.cfg, run.role)?.name || run.role} run failed: ${run.purpose}. ${error || ''}`.slice(0, 900),
          JSON.stringify(['Retry', 'Dismiss']), now());
    }
    this.onEvent({ type: 'run-end', runId: id, status });

    // Messages that arrived after the agent's last tool call (e.g. an owner answer) resume it now.
    if (status !== 'stopped' && status !== 'parked') {
      const pending = db.prepare(`SELECT * FROM messages WHERE run_id = ? AND to_role = ? AND delivered_at IS NULL
        AND kind IN ('answer','chat','note') ORDER BY id`).all(id, run.role);
      if (pending.length) this.resumeWith(id, pending);
    }
  }

  stop(runId) {
    const state = this.procs.get(runId);
    this.db.prepare("UPDATE runs SET status = 'stopped', ended_at = ? WHERE id = ? AND status IN ('running','parked')").run(now(), runId);
    releaseAll(this.db, `run:${runId}`, 'stopped by owner');
    if (state) killTree(state.child.pid);
    // A stopped run means "not like this": park its idea until the owner resumes it.
    const run = this.db.prepare('SELECT idea_id FROM runs WHERE id = ?').get(runId);
    const idea = run?.idea_id ? this.db.prepare('SELECT status FROM ideas WHERE id = ?').get(run.idea_id) : null;
    if (idea && !['shipped', 'rejected', 'on_hold'].includes(idea.status)) {
      updateIdea(this.db, this.cfg, run.idea_id, { status: 'on_hold', note: `run ${runId} stopped by the owner` }, 'owner');
    }
    return !!state;
  }

  // Resume a finished/parked run's session with these messages as the next user turn.
  resumeWith(runId, messages, { ownerAction = true } = {}) {
    const prev = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!prev?.session_id) throw new Error(`run ${runId} has no session to resume`);
    const mark = this.db.prepare('UPDATE messages SET delivered_at = ?, delivered_run_id = ? WHERE id = ?');
    const texts = messages.map((m) => (m.kind === 'answer' ? m.text : `Message from ${m.from_role === 'owner' ? 'the owner' : m.from_role}: ${m.text}`));
    if (prev.status === 'parked') this.db.prepare("UPDATE runs SET status = 'resumed' WHERE id = ?").run(runId);
    const id = this.start({
      role: prev.role, purpose: prev.purpose.startsWith('↻') ? prev.purpose : `↻ ${prev.purpose}`, prompt: resumePrompt(texts),
      ideaId: prev.idea_id, loopId: prev.loop_id, taskType: prev.task_type, model: prev.model, modelWhy: prev.model_why,
      resumeSessionId: prev.session_id, resumedFrom: prev.id, chat: messages.some((m) => m.kind === 'chat' || m.kind === 'answer'), ownerAction,
    });
    for (const m of messages) mark.run(now(), id, m.id);
    return id;
  }

  // Owner answers a question from the dashboard.
  answer(questionId, answer) {
    const db = this.db;
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
    if (!q) throw new Error(`question #${questionId} not found`);
    if (q.status !== 'open') throw new Error(`question #${questionId} is already ${q.status}`);
    if (q.kind === 'approval') {
      decideApproval(db, this.cfg, q.idea_id, /^approve/i.test(answer), /^approve|^reject/i.test(answer) ? '' : answer);
      return { done: 'approval' };
    }
    db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_at = ?, handled = 1 WHERE id = ?").run(answer, now(), questionId);
    if (q.idea_id) addIdeaEvent(db, q.idea_id, 'owner', 'answer', `#${questionId}: ${answer}`);
    if (q.kind === 'failure') {
      if (/^retry/i.test(answer) && q.run_id) return { retried: this.retry(q.run_id) };
      return { done: 'dismissed' };
    }
    if (q.kind === 'hold') {
      if (/^try/i.test(answer)) updateIdea(db, this.cfg, q.idea_id, { status: 'triaged', note: 'owner: try again' }, 'owner');
      else if (/^reject/i.test(answer)) updateIdea(db, this.cfg, q.idea_id, { status: 'rejected', note: 'owner rejected it' }, 'owner');
      return { done: 'hold' };
    }
    if (!q.run_id) return { done: 'answered' };
    const asked = db.prepare('SELECT * FROM runs WHERE id = ?').get(q.run_id);
    // A session can have been resumed since the question was asked; talk to its newest run.
    const run = this.latestInSession(asked);
    const text = `Owner answered your question #${questionId} ("${q.text.slice(0, 200)}"): ${answer}`;
    const msgId = sendMessage(db, { from: 'owner', to: run.role, runId: run.id, text, kind: 'answer' });
    if (run.kind === 'factory' && !this.isActive(run.id) && run.session_id) {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
      return { resumed: this.resumeWith(run.id, [msg]) };
    }
    return { queued: true };
  }

  latestInSession(run) {
    if (!run?.session_id || run.kind !== 'factory') return run;
    return this.db.prepare("SELECT * FROM runs WHERE session_id = ? AND kind = 'factory' ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(run.session_id) || run;
  }

  retry(runId) {
    const prev = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!prev) throw new Error(`run ${runId} not found`);
    return this.start({ role: prev.role, purpose: prev.purpose, prompt: prev.prompt, ideaId: prev.idea_id, loopId: prev.loop_id,
      taskType: prev.task_type, ownerAction: true });
  }

  // Owner chat with a role: deliver to a live run, resume its latest session, or start a fresh one.
  chat(roleId, text) {
    const db = this.db;
    if (!roleById(this.cfg, roleId)) throw new Error(`unknown role "${roleId}"`);
    const live = db.prepare("SELECT * FROM runs WHERE kind = 'factory' AND role = ? AND status = 'running' ORDER BY started_at DESC").all(roleId)
      .find((r) => this.isActive(r.id));
    if (live) {
      sendMessage(db, { from: 'owner', to: roleId, runId: live.id, text, kind: 'chat' });
      return { delivered: 'live', runId: live.id };
    }
    const msgId = sendMessage(db, { from: 'owner', to: roleId, text, kind: 'chat' });
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    const recent = db.prepare(`SELECT * FROM runs WHERE kind = 'factory' AND role = ? AND session_id IS NOT NULL
      AND status IN ('done','parked','resumed') AND started_at >= ? ORDER BY started_at DESC LIMIT 1`)
      .get(roleId, new Date(Date.now() - 24 * 3600_000).toISOString());
    if (recent) {
      const latest = this.latestInSession(recent);
      if (this.isActive(latest.id)) {
        db.prepare('UPDATE messages SET run_id = ? WHERE id = ?').run(latest.id, msgId);
        return { delivered: 'live', runId: latest.id };
      }
      return { delivered: 'resumed', runId: this.resumeWith(latest.id, [msg]) };
    }
    const id = this.start({ role: roleId, purpose: 'Chat with the owner', prompt: chatPrompt(text), chat: true, ownerAction: true });
    db.prepare('UPDATE messages SET delivered_at = ?, delivered_run_id = ? WHERE id = ?').run(now(), id, msgId);
    return { delivered: 'new', runId: id };
  }
}
