// Logic behind the Claude Code hooks (factory/hooks/hook.mjs is the thin CLI wrapper).
// Returns the JSON object the hook should print, or null for "no opinion". Never returns
// permissionDecision 'allow' — that would bypass the session's own permission rules.
import path from 'node:path';
import { now, logActivity, kvSet } from './db.mjs';
import { identify } from './identity.mjs';
import { matchResource, claim, touch, release, releaseAll, normPath, liveFileClaims } from './resources.mjs';
import { buildSnapshot, takeMessages, formatMessages, roleName, describeHolder } from './snapshot.mjs';
import { unmetDeps } from './ideas.mjs';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const short = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

export function summarizeTool(name, input = {}) {
  if (name === 'Bash' || name === 'PowerShell') return short(String(input.command || '').replace(/\s+/g, ' '), 140);
  if (FILE_TOOLS.has(name) || name === 'Read') return normPath(input.file_path || input.notebook_path || '');
  if (name === 'Grep' || name === 'Glob') return short(`${input.pattern || ''} ${input.path ? `in ${normPath(input.path)}` : ''}`, 120);
  if (name === 'Agent' || name === 'Task') return short(`${input.subagent_type || 'agent'}: ${input.description || ''}`, 120);
  if (name === 'WebFetch' || name === 'WebSearch') return short(input.url || input.query || '', 120);
  const args = Object.entries(input).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${String(v)}`).join(' ');
  return short(args, 120);
}

function touchRun(db, who, status) {
  if (!who.runId) return;
  if (status) db.prepare('UPDATE runs SET last_activity_at = ?, status = ? WHERE id = ?').run(now(), status, who.runId);
  else db.prepare('UPDATE runs SET last_activity_at = ? WHERE id = ?').run(now(), who.runId);
}

const canon = (p) => {
  const n = path.posix.normalize(normPath(p)).replace(/^\.\//, '').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

function isProtected(cfg, filePath) {
  const p = canon(filePath);
  return (cfg.guards.protectedPaths || []).some((g) => {
    const c = canon(g) + (g.endsWith('/') ? '/' : '');
    return g.endsWith('/') ? p.startsWith(c) || `${p}/` === c : p === c;
  });
}

// Shell commands that look like they write to a protected path (redirects, copy/move/delete,
// in-place edits, scripted file writes). A heuristic backstop for the Edit/Write check.
const WRITE_HINT = /(>|\btee\b|\bsed\s+-i|\b(cp|mv|rm|del|copy|move|ren)\b|Set-Content|Add-Content|Out-File|Remove-Item|Copy-Item|Move-Item|New-Item|Rename-Item|writeFile|appendFile|unlink|rmSync|renameSync|copyFile|open\([^)]*['"][wa])/i;
function shellWritesProtected(cfg, command) {
  const writes = command.replace(/=>/g, ' ').replace(/\d?>&\d/g, ' ').replace(/\d?>\s*(\$null|\/dev\/null|nul)\b/gi, ' ');
  if (!WRITE_HINT.test(writes)) return null;
  const cmd = command.replace(/\\/g, '/');
  const low = process.platform === 'win32' ? cmd.toLowerCase() : cmd;
  return (cfg.guards.protectedPaths || []).find((g) => low.includes(process.platform === 'win32' ? g.toLowerCase() : g)) || null;
}

function sessionStart(db, cfg, who, input) {
  if (who.kind === 'factory') {
    db.prepare('UPDATE runs SET session_id = COALESCE(session_id, ?), transcript_path = ?, last_activity_at = ? WHERE id = ?')
      .run(input.session_id, input.transcript_path || null, now(), who.runId);
  } else if (who.runId) {
    db.prepare("UPDATE runs SET status = 'running', transcript_path = COALESCE(?, transcript_path), last_activity_at = ? WHERE id = ?")
      .run(input.transcript_path || null, now(), who.runId);
  }
  logActivity(db, { runId: who.runId, sessionId: who.sessionId, role: who.role, kind: 'status', summary: `session ${input.source || 'start'}` });
  let ctx = buildSnapshot(db, cfg, who);
  const msgs = takeMessages(db, who);
  if (msgs.length) ctx += `\nMessages for you:\n${formatMessages(cfg, msgs)}`;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } };
}

function preToolUse(db, cfg, who, input) {
  const name = input.tool_name;
  const toolInput = input.tool_input || {};
  // MCP calls carry no session id; tell the factory MCP server who is about to call it.
  if (name.startsWith('mcp__factory__') && who.kind === 'interactive') {
    kvSet(db, 'mcp_caller', JSON.stringify({ session_id: input.session_id, agent_type: input.agent_type || null,
      agent_id: input.agent_id || null, ts: Date.now() }));
    return null;
  }
  if (who.kind === 'factory' && FILE_TOOLS.has(name) && isProtected(cfg, toolInput.file_path || toolInput.notebook_path || '')) {
    logActivity(db, { runId: who.runId, role: who.role, kind: 'gate', toolName: name, summary: `blocked edit of protected file ${normPath(toolInput.file_path || '')}` });
    return deny(`${normPath(toolInput.file_path)} is a protected Factory file (factory/guards.json protectedPaths). `
      + 'Only the owner edits it. If a change is needed, call ask_owner or propose_idea with kind "tech".');
  }
  if (who.kind === 'factory' && (name === 'Bash' || name === 'PowerShell')) {
    const hit = shellWritesProtected(cfg, String(toolInput.command || ''));
    if (hit) {
      logActivity(db, { runId: who.runId, role: who.role, kind: 'gate', toolName: name, summary: `blocked shell write near protected ${hit}` });
      return deny(`This command looks like it writes to ${hit}, a protected Factory path. Only the owner changes it; `
        + 'use ask_owner or propose_idea (kind "tech") instead. Reading it is fine.');
    }
  }
  const resourceId = matchResource(cfg, name, toolInput);
  if (!resourceId) return null;
  const waiting = studioWait(db, who, resourceId);
  if (waiting) {
    logActivity(db, { runId: who.runId, role: who.role, kind: 'gate', toolName: name, summary: `denied Roblox Studio: idea #${who.ideaId} waits for ${waiting}` });
    return deny(`Idea #${who.ideaId} may not use Roblox Studio until ${waiting} ships (it is not your turn yet). Do the work that `
      + 'does not need Studio, then update_idea status "staged" with a note and end your turn; the Factory resumes you for your Studio turn.');
  }
  const res = claim(db, cfg, resourceId, {
    key: who.key, kind: who.kind, runId: who.kind === 'factory' ? who.runId : null, sessionId: who.sessionId,
    role: who.role, reason: who.purpose || summarizeTool(name, toolInput), ideaId: who.ideaId,
  });
  if (res.ok) {
    if (!res.already) logActivity(db, { runId: who.runId, role: who.role, kind: 'gate', toolName: name, summary: `claimed ${resourceId}` });
    return null;
  }
  const rname = cfg.resources.find((r) => r.id === resourceId)?.name || resourceId;
  const holder = res.holders[0];
  if (who.kind === 'interactive') {
    // The owner's own sessions are never blocked; they get a heads-up after the call.
    logActivity(db, { runId: who.runId, role: who.role, kind: 'gate', toolName: name, summary: `used ${rname} while held by ${holder ? roleName(cfg, holder.role) : 'a queued run'} (owner override)` });
    return null;
  }
  const by = holder ? describeHolder(cfg, holder) : `reserved for ${roleName(cfg, res.reservedFor?.role)} (queued first)`;
  logActivity(db, { runId: who.runId, role: who.role, kind: 'gate', toolName: name, summary: `denied ${rname}: held by ${by}` });
  return deny(`${rname} is in use: ${by}. You are #${res.position} in its queue. Work on parts that don't need ${rname}, `
    + `or end your turn with a short status — the Factory resumes queued work when ${rname} frees up.`);
}

// Factory runs for an idea whose dependencies have not shipped may prepare but not use Studio.
export function studioWait(db, who, resourceId) {
  if (resourceId !== 'studio' || who.kind !== 'factory' || !who.ideaId) return null;
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(who.ideaId);
  const waits = idea ? unmetDeps(db, idea) : [];
  return waits.length ? waits.map((d) => `#${d}`).join(', ') : null;
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function postToolUse(db, cfg, who, input) {
  const name = input.tool_name;
  const toolInput = input.tool_input || {};
  const files = FILE_TOOLS.has(name) ? [normPath(toolInput.file_path || toolInput.notebook_path || '')] : null;
  const failed = input.tool_response && typeof input.tool_response === 'object' && input.tool_response.is_error;
  logActivity(db, { runId: who.runId, sessionId: who.sessionId, role: who.role, kind: files ? 'file' : 'tool', toolName: name,
    summary: `${failed ? '✗ ' : ''}${summarizeTool(name, toolInput)}`, files });
  touchRun(db, who, who.kind === 'interactive' ? 'running' : null);

  const notes = [];
  const resourceId = matchResource(cfg, name, toolInput);
  if (resourceId === 'git') {
    // A commit only needs the lock while it runs; holding it afterwards blocked other agents' commits.
    release(db, 'git', who.key, 'commit finished');
  } else if (resourceId) {
    touch(db, resourceId, who.key);
    if (who.kind === 'interactive') {
      const other = db.prepare('SELECT * FROM holds WHERE resource_id = ? AND released_at IS NULL AND holder_key != ?').get(resourceId, who.key);
      if (other) notes.push(`Heads-up: ${cfg.resources.find((r) => r.id === resourceId)?.name} is also held by ${describeHolder(cfg, other)}. Coordinate before changing its state.`);
    }
  }
  if (files) {
    const clash = liveFileClaims(db).find((c) => c.path === files[0] && c.holder_key !== who.key);
    if (clash) notes.push(`Heads-up: ${files[0]} is claimed by ${roleName(cfg, clash.role)} (${clash.reason || 'no reason'}). Message them with send_note before further edits.`);
  }
  const msgs = takeMessages(db, who);
  if (msgs.length) notes.push(`New messages:\n${formatMessages(cfg, msgs)}`);
  if (!notes.length) return null;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join('\n') } };
}

export function handleHook(db, cfg, event, input, env = process.env) {
  const who = identify(db, cfg, env, input);
  switch (event) {
    case 'SessionStart':
      return sessionStart(db, cfg, who, input);
    case 'UserPromptSubmit':
      touchRun(db, who, who.kind === 'interactive' ? 'running' : null);
      return null;
    case 'PreToolUse':
      return preToolUse(db, cfg, who, input);
    case 'PostToolUse':
      return postToolUse(db, cfg, who, input);
    case 'SubagentStart':
    case 'SubagentStop':
      logActivity(db, { runId: who.runId, sessionId: who.sessionId, role: who.role, kind: 'status',
        summary: `${event === 'SubagentStart' ? 'started' : 'finished'} subagent ${input.agent_type || ''}`.trim() });
      if (event === 'SubagentStop' && input.agent_id && who.sessionId) releaseAll(db, `session:${who.sessionId}:${input.agent_id}`, 'subagent finished');
      return null;
    case 'Stop':
      if (who.kind === 'interactive') touchRun(db, who, 'idle');
      return null;
    case 'SessionEnd':
      releaseAll(db, who.key, 'session ended');
      if (who.kind === 'interactive' && who.runId) {
        db.prepare("UPDATE runs SET status = 'ended', ended_at = ? WHERE id = ?").run(now(), who.runId);
      }
      logActivity(db, { runId: who.runId, sessionId: who.sessionId, role: who.role, kind: 'status', summary: `session ended (${input.reason || 'exit'})` });
      return null;
    default:
      return null;
  }
}
