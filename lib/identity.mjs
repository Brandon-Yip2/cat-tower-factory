// Who is calling: a Factory run (FACTORY_RUN_ID in env) or an interactive Claude Code session.
import { now } from './db.mjs';
import { roleByAgent } from './config.mjs';

export function identify(db, cfg, env, input = {}) {
  const sessionId = input.session_id || null;
  const runIdEnv = env.FACTORY_RUN_ID || null;
  if (runIdEnv) {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runIdEnv);
    if (run) {
      return { kind: 'factory', runId: run.id, sessionId, role: run.role, ideaId: run.idea_id, run, key: `run:${run.id}`,
        purpose: run.purpose };
    }
  }
  // Interactive: one run row per session; subagents inside it hold tools under their own key.
  const runId = sessionId ? `i-${sessionId}` : null;
  const subRole = roleByAgent(cfg, input.agent_type)?.id;
  const role = subRole || (input.agent_type ? input.agent_type : 'owner-session');
  const key = sessionId ? `session:${sessionId}${input.agent_id ? `:${input.agent_id}` : ''}` : 'session:unknown';
  let run = runId ? db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) : null;
  if (!run && runId) {
    const t = now();
    db.prepare(`INSERT OR IGNORE INTO runs (id, kind, role, agent_type, session_id, status, purpose, started_at,
        last_activity_at, transcript_path) VALUES (?, 'interactive', ?, ?, ?, 'running', ?, ?, ?, ?)`)
      .run(runId, role, input.agent_type || null, sessionId, 'Interactive Claude Code session', t, t,
        input.transcript_path || null);
    run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  }
  return { kind: 'interactive', runId, sessionId, role, ideaId: run?.idea_id || null, run, key,
    purpose: subRole ? `${subRole} (subagent in interactive session)` : 'interactive session' };
}

// MCP calls carry no session id. Factory runs pass FACTORY_RUN_ID; interactive sessions are
// identified by the PreToolUse hook, which records the caller just before each factory tool call.
export function identifyForMcp(db, cfg, env) {
  if (env.FACTORY_RUN_ID) {
    const who = identify(db, cfg, env, {});
    if (who.kind === 'factory') return who;
  }
  const raw = db.prepare("SELECT value FROM kv WHERE key = 'mcp_caller'").get()?.value;
  const caller = raw ? JSON.parse(raw) : null;
  if (caller && Date.now() - caller.ts < 15_000 && caller.session_id) return identify(db, cfg, {}, caller);
  const run = db.prepare(`SELECT * FROM runs WHERE kind = 'interactive' AND status IN ('running','idle')
    ORDER BY last_activity_at DESC LIMIT 1`).get();
  if (!run) return { kind: 'interactive', runId: null, sessionId: null, role: 'owner-session', ideaId: null, key: 'session:unknown', purpose: 'interactive session' };
  return { kind: 'interactive', runId: run.id, sessionId: run.session_id, role: run.role, ideaId: run.idea_id, run,
    key: `session:${run.session_id}`, purpose: 'interactive session' };
}
