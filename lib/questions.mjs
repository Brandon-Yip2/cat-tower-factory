// Questions for the owner ("Needs you") and messages between the owner and agents.
import { now, logActivity } from './db.mjs';
import { addIdeaEvent } from './ideas.mjs';

export function askOwner(db, who, { question, choices = null, blocking = true, kind = 'question', ideaId = null }) {
  const text = String(question || '').trim();
  if (!text) throw new Error('question is required');
  const info = db.prepare(`INSERT INTO questions (run_id, session_id, role, idea_id, kind, text, choices, blocking, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(who.runId || null, who.sessionId || null, who.role || null, ideaId ?? who.ideaId ?? null, kind, text.slice(0, 2000),
      Array.isArray(choices) && choices.length ? JSON.stringify(choices.slice(0, 6).map(String)) : null, blocking ? 1 : 0, now());
  const id = Number(info.lastInsertRowid);
  logActivity(db, { runId: who.runId, role: who.role, kind: 'question', summary: `asked owner #${id}: ${text.slice(0, 200)}` });
  if (ideaId ?? who.ideaId) addIdeaEvent(db, ideaId ?? who.ideaId, who.role || 'agent', 'question', text);
  return id;
}

export function openQuestions(db) {
  return db.prepare(`SELECT q.*, i.title AS idea_title FROM questions q LEFT JOIN ideas i ON i.id = q.idea_id
    WHERE q.status = 'open' ORDER BY q.created_at`).all()
    .map((q) => ({ ...q, choices: q.choices ? JSON.parse(q.choices) : null }));
}

export function sendMessage(db, { from, to, text, runId = null, kind = 'chat' }) {
  const info = db.prepare('INSERT INTO messages (ts, kind, from_role, to_role, run_id, text) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now(), kind, from, to, runId, String(text).slice(0, 4000));
  return Number(info.lastInsertRowid);
}

export function chatHistory(db, role, limit = 60) {
  return db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE (to_role = @r OR from_role = @r) AND kind IN ('chat','answer','reply')
    ORDER BY id DESC LIMIT @n) ORDER BY id`).all({ r: role, n: limit });
}
