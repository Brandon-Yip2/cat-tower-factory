#!/usr/bin/env node
// "factory" MCP server (stdio, newline-delimited JSON-RPC 2.0). Gives agents the shared
// Factory state: tool locks, ideas, questions for the owner, notes to teammates.
import readline from 'node:readline';
import { openDb, now, logActivity } from '../lib/db.mjs';
import { loadConfig, roleById } from '../lib/config.mjs';
import { identifyForMcp } from '../lib/identity.mjs';
import { buildSnapshot, describeHolder, roleName } from '../lib/snapshot.mjs';
import { claim, release, resourceView, claimFiles } from '../lib/resources.mjs';
import { createIdea, updateIdea, getIdea, listIdeas, KINDS, STATUSES } from '../lib/ideas.mjs';
import { askOwner, sendMessage } from '../lib/questions.mjs';
import { buildDigest } from '../lib/digest.mjs';
import { openApp, appStatus } from '../lib/apps.mjs';
import { proposePass, revisePass, pendingProposals } from '../lib/proposals.mjs';
import { readyWork } from '../lib/dispatcher.mjs';

const db = openDb();
const cfgNow = () => loadConfig();

const str = (description) => ({ type: 'string', description });
const TOOLS = [
  { name: 'factory_status', description: 'Snapshot of the Factory: who holds Studio/Blender/uploader/git and why, who is working on what, claimed files, your idea, pipeline counts.', inputSchema: { type: 'object', properties: {} } },
  { name: 'who_is_using', description: 'Holder, reason and queue for one single-user tool (studio, blender, uploader, git).', inputSchema: { type: 'object', properties: { resource: str('studio | blender | uploader | git') }, required: ['resource'] } },
  { name: 'claim_tool', description: 'Claim a single-user tool before a long stretch of work with it (tools are also auto-claimed on first use). Fails with the holder and your queue place if busy.', inputSchema: { type: 'object', properties: { resource: str('studio | blender | uploader | git'), reason: str('What you will do with it (shown to everyone)') }, required: ['resource', 'reason'] } },
  { name: 'release_tool', description: 'Release a single-user tool as soon as you are done with it.', inputSchema: { type: 'object', properties: { resource: str('studio | blender | uploader | git') }, required: ['resource'] } },
  { name: 'claim_files', description: 'Tell other agents which files you are editing (advisory; shown in every snapshot).', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, reason: str('why') }, required: ['paths'] } },
  { name: 'list_ideas', description: 'List ideas in the pipeline.', inputSchema: { type: 'object', properties: { status: str(`one of ${STATUSES.join(', ')}`), area: str('area filter'), active_only: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'get_idea', description: 'Full history of one idea: provenance, timeline, runs, questions.', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'propose_idea', description: 'Add a new idea to the inbox. Never start building it yourself. Pass parent_id when it serves an existing owner idea. Brand-new features with no parent wait for the owner.', inputSchema: { type: 'object', properties: { title: str('short title'), description: str('what and why, with repro steps for bugs'), kind: str(KINDS.join(' | ')), area: str('area'), parent_id: { type: 'number' }, task_type: str('routing task type, if known') }, required: ['title', 'description', 'kind'] } },
  { name: 'update_idea', description: 'Move or annotate an idea (status, notes, triage fields). Statuses: inbox, triaged, spec, building, staged (prepared, waiting for its Studio turn), qa, shipped, on_hold, rejected.', inputSchema: { type: 'object', properties: { id: { type: 'number' }, status: str('new status'), note: str('what changed and why'), area: str(''), kind: str(''), task_type: str(''), owner_role: str('role id'), priority: { type: 'number' }, needs_spec: { type: 'boolean' }, spec_path: str(''), parent_id: { type: 'number' }, summary: str('one-paragraph summary of what shipped'), approval_reason: str('why it needs the owner'), depends_on: { type: 'array', items: { type: 'number' }, description: 'ids of ideas that must ship first' } }, required: ['id'] } },
  { name: 'ask_owner', description: 'Ask the owner a question that only they can answer (taste, direction, trade-offs). With blocking=true (default) you must end your turn right after; you will be resumed in this session with the answer.', inputSchema: { type: 'object', properties: { question: str('the question, with enough context to answer from a phone'), choices: { type: 'array', items: { type: 'string' }, description: '2-4 one-click answers (optional)' }, blocking: { type: 'boolean' } }, required: ['question'] } },
  { name: 'send_note', description: 'Leave a note for another role; it reaches their running session at its next tool call, or their next run.', inputSchema: { type: 'object', properties: { to_role: str('role id, e.g. qa-lead'), text: str('the note') }, required: ['to_role', 'text'] } },
  { name: 'report_progress', description: 'Update your progress bar on the dashboard.', inputSchema: { type: 'object', properties: { percent: { type: 'number' }, note: str('what you are doing now') }, required: ['percent'] } },
  { name: 'record_improvement', description: 'Factory Engineer: record a change made to the Factory itself (CLAUDE.md, agent definitions, config, prompts).', inputSchema: { type: 'object', properties: { kind: str('instructions | agent | routing | loop | prompt | other'), title: str(''), why: str(''), evidence: str('numbers from the digest'), files: { type: 'array', items: { type: 'string' } }, commit: str('commit sha') }, required: ['kind', 'title', 'why'] } },
  { name: 'open_app', description: 'Open Roblox Studio on the Cat Tower place, or Blender (optionally a .blend under visuals/). Use this instead of asking the owner to open them. Claims the tool lock for the app first; never opens a second copy.', inputSchema: { type: 'object', properties: { app: str('studio | blender'), file: str('blender only: a .blend path under visuals/, e.g. visuals/seedlight/Seedlight.blend') }, required: ['app'] } },
  { name: 'app_status', description: 'Whether Roblox Studio and Blender are open right now.', inputSchema: { type: 'object', properties: {} } },
  { name: 'propose_pass', description: 'Game Manager: send the owner a pass (a bundle of tasks for several roles). The owner approves it with one click (maybe with additions) or denies it; approved tasks go to the backlog.', inputSchema: { type: 'object', properties: { title: str('short pass name'), why: str('2-3 sentences for the owner'), tasks: { type: 'array', description: 'the tasks, in order', items: { type: 'object', properties: { title: str('short, specific'), description: str('what to do, done criteria, how QA checks it'), owner_role: str('role id that builds it'), task_type: str('routing task type'), area: str('area'), kind: str('feature | bug | polish | tuning | content | tech'), priority: { type: 'number' }, after: { type: 'array', items: { type: 'number' }, description: 'task numbers in this pass that must ship first' }, after_ideas: { type: 'array', items: { type: 'number' }, description: 'existing idea ids that must ship first' }, idea_id: { type: 'number', description: 'include an existing suggested idea instead of a new task' } }, required: ['owner_role'] } } }, required: ['title', 'why', 'tasks'] } },
  { name: 'revise_pass', description: 'Improve a pass that is still waiting for the owner.', inputSchema: { type: 'object', properties: { id: { type: 'number' }, title: str(''), why: str(''), tasks: { type: 'array', description: 'the tasks, in order', items: { type: 'object', properties: { title: str('short, specific'), description: str('what to do, done criteria, how QA checks it'), owner_role: str('role id that builds it'), task_type: str('routing task type'), area: str('area'), kind: str('feature | bug | polish | tuning | content | tech'), priority: { type: 'number' }, after: { type: 'array', items: { type: 'number' }, description: 'task numbers in this pass that must ship first' }, after_ideas: { type: 'array', items: { type: 'number' }, description: 'existing idea ids that must ship first' }, idea_id: { type: 'number', description: 'include an existing suggested idea instead of a new task' } }, required: ['owner_role'] } } }, required: ['id'] } },
  { name: 'list_backlog', description: 'The shared backlog: tasks ready to start per role, tasks staged or waiting for others, and passes waiting for the owner. Use it to see what other agents will do next.', inputSchema: { type: 'object', properties: { role: str('only this role (optional)') } } },
  { name: 'factory_stats', description: 'Digest of the last N days of runs: tokens, durations, redo reasons, tool-gate denials, failures.', inputSchema: { type: 'object', properties: { days: { type: 'number' } } } },
];

async function call(name, a, cfg, who) {
  if (a.resource === undefined && a.tool !== undefined) a.resource = a.tool; // agents often say "tool"
  switch (name) {
    case 'open_app':
      return openApp(db, cfg, a.app, who, { file: a.file || null });
    case 'app_status':
      return appStatus(cfg).map((x) => `${x.name}: ${x.running ? 'open' : 'closed'}`).join('\n');
    case 'propose_pass':
      return `Pass #${proposePass(db, cfg, who, a)} is waiting for the owner. End your turn now.`;
    case 'revise_pass':
      return `Pass #${revisePass(db, cfg, who, a.id, a)} updated.`;
    case 'list_backlog': {
      const rows = listIdeas(db, { stageGroup: 'active' }).filter((i) => ['approved', 'owner_approved'].includes(i.approval) && (!a.role || i.owner_role === a.role));
      const ready = new Set(readyWork(db, { isActive: () => false }).map((i) => i.id));
      const fmt = (i) => `#${i.id} [${i.status}] ${i.title}${i.owner_role ? ` — ${i.owner_role}` : ''}${i.depends_on ? ` (after ${JSON.parse(i.depends_on).map((d) => '#' + d).join(', ')})` : ''}`;
      const out = [];
      const byRole = new Map();
      for (const i of rows) { const k = i.owner_role || 'unassigned'; if (!byRole.has(k)) byRole.set(k, []); byRole.get(k).push(i); }
      for (const [role, list] of byRole) {
        out.push(`${role}:\n${list.map((i) => `  ${ready.has(i.id) ? '' : '(waiting) '}${fmt(i)}`).join('\n')}`);
      }
      const pending = pendingProposals(db, cfg);
      if (pending.length) out.push(`Passes waiting for the owner: ${pending.map((p) => `#${p.id} "${p.title}" (${p.tasks.length} tasks)`).join('; ')}`);
      return out.join('\n') || 'The backlog is empty.';
    }
    case 'factory_status':
      return buildSnapshot(db, cfg, who, { full: true });
    case 'who_is_using': {
      const r = resourceView(db, cfg).find((x) => x.id === a.resource);
      if (!r) throw new Error(`unknown tool "${a.resource}"; use ${cfg.resources.map((x) => x.id).join(', ')}`);
      const held = r.holders.length ? r.holders.map((h) => describeHolder(cfg, h)).join('; ') : 'free';
      const q = r.queue.length ? r.queue.map((x, i) => `${i + 1}. ${roleName(cfg, x.role)} — ${x.reason || ''}`).join('\n') : 'empty';
      return `${r.name}: ${held}\nQueue: ${q}`;
    }
    case 'claim_tool': {
      const res = claim(db, cfg, a.resource, { key: who.key, kind: who.kind, runId: who.kind === 'factory' ? who.runId : null, sessionId: who.sessionId, role: who.role, reason: a.reason, ideaId: who.ideaId });
      if (res.ok) return `You hold ${a.resource}. Release it with release_tool as soon as you are done.`;
      const h = res.holders[0];
      throw new Error(`${a.resource} is busy: ${h ? describeHolder(cfg, h) : 'reserved for the queue head'}. You are #${res.position} in the queue.`);
    }
    case 'release_tool':
      return release(db, a.resource, who.key) ? `Released ${a.resource}.` : `You did not hold ${a.resource}.`;
    case 'claim_files':
      claimFiles(db, who, a.paths || [], a.reason || '');
      return `Claimed ${(a.paths || []).length} file(s).`;
    case 'list_ideas': {
      const rows = listIdeas(db, { status: a.status, area: a.area, stageGroup: a.active_only ? 'active' : undefined, limit: a.limit || 40 });
      return rows.map((i) => `#${i.id} [${i.status}] ${i.title} — ${i.kind}${i.area ? `, ${i.area}` : ''}${i.owner_role ? `, owner ${i.owner_role}` : ''}${i.task_type ? `, ${i.task_type}` : ''}${i.approval === 'needs_owner' ? ', NEEDS OWNER' : ''}`).join('\n') || 'No ideas match.';
    }
    case 'get_idea': {
      const i = getIdea(db, a.id);
      if (!i) throw new Error(`idea #${a.id} not found`);
      return JSON.stringify({ ...i, events: i.events.slice(-25) }, null, 1);
    }
    case 'propose_idea': {
      const origin = who.run?.loop_id && a.kind === 'bug' ? 'qa' : who.run?.loop_id ? 'loop' : 'agent';
      const idea = createIdea(db, cfg, { title: a.title, description: a.description, kind: a.kind, area: a.area, parentId: a.parent_id, taskType: a.task_type, origin: who.kind === 'interactive' && who.role === 'owner-session' ? 'owner' : origin, originRole: who.role, originRunId: who.runId });
      return `Idea #${idea.id} added to the inbox (${idea.approval === 'needs_owner' ? 'brand-new: it will wait for the owner after triage' : 'will be triaged and scheduled automatically'}). Do not start building it in this run.`;
    }
    case 'update_idea': {
      const { id, ...patch } = a;
      const idea = updateIdea(db, cfg, id, patch, who.role || 'agent');
      return `Idea #${idea.id} is now ${idea.status}.`;
    }
    case 'ask_owner': {
      const blocking = a.blocking !== false;
      const id = askOwner(db, who, { question: a.question, choices: a.choices, blocking });
      if (who.kind === 'interactive') return `Question #${id} is on the dashboard. The owner may answer here in chat instead.`;
      if (blocking) return `Question #${id} is on the owner's dashboard. End your turn NOW: reply with one line saying what you are waiting for, and stop. You will be resumed in this same session with the answer.`;
      return `Question #${id} posted. Continue with your best default (say which); the answer will reach you as a message if you are still running.`;
    }
    case 'send_note': {
      if (!roleById(cfg, a.to_role)) throw new Error(`unknown role "${a.to_role}"; roles: ${cfg.roles.map((r) => r.id).join(', ')}`);
      sendMessage(db, { from: who.role || 'agent', to: a.to_role, text: a.text, kind: 'note' });
      return `Note queued for ${a.to_role}.`;
    }
    case 'report_progress':
      if (who.runId) db.prepare('UPDATE runs SET progress = ?, progress_note = ?, last_activity_at = ? WHERE id = ?').run(Math.max(0, Math.min(100, Math.round(a.percent))), a.note || null, now(), who.runId);
      return 'Progress noted.';
    case 'record_improvement': {
      const info = db.prepare(`INSERT INTO improvements (ts, kind, title, why, evidence, files, commit_sha, actor, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(now(), a.kind, a.title, a.why, a.evidence || '', JSON.stringify(a.files || []), a.commit || null, who.role || 'agent', who.runId);
      logActivity(db, { runId: who.runId, role: who.role, kind: 'note', summary: `improvement: ${a.title}` });
      return `Improvement #${info.lastInsertRowid} recorded.`;
    }
    case 'factory_stats':
      return buildDigest(db, cfg, { days: a.days || 3 });
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function fail(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'parse error'); }
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return; // notification
  try {
    if (method === 'initialize') {
      return reply(id, { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'factory', version: '1.0.0' } });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const cfg = cfgNow();
      const who = identifyForMcp(db, cfg, process.env);
      try {
        const text = await call(params.name, params.arguments || {}, cfg, who);
        return reply(id, { content: [{ type: 'text', text: String(text) }] });
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    return fail(id, -32601, `method not found: ${method}`);
  } catch (err) {
    return fail(id, -32603, err.message);
  }
});
rl.on('close', () => { db.close(); process.exit(0); });
