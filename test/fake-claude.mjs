// Stand-in for `claude -p` in tests: echoes a stream-json conversation. The prompt steers it:
//   "ASK"  → files a blocking question for this run (like ask_owner) before finishing
//   "FAIL" → exits without a result
//   "SLOW" → waits 600 ms before finishing
import fs from 'node:fs';
import { openDb } from '../lib/db.mjs';

let prompt = '';
for await (const c of process.stdin) prompt += c;
const args = process.argv.slice(2);
if (process.env.FAKE_ARGS_LOG) fs.appendFileSync(process.env.FAKE_ARGS_LOG, `${JSON.stringify({ args, prompt })}\n`);
const sid = args[args.indexOf('--session-id') + 1] || args[args.indexOf('--resume') + 1];
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' });
out({ type: 'assistant', message: { content: [{ type: 'text', text: `working on: ${prompt.slice(0, 40)}` }] }, session_id: sid });
if (prompt.includes('SLOW')) await new Promise((r) => setTimeout(r, 600));
if (prompt.includes('FAIL')) { process.stderr.write('boom\n'); process.exit(3); }
if (prompt.includes('ASK')) {
  const db = openDb(process.env.FACTORY_DB);
  db.prepare("INSERT INTO questions (run_id, role, kind, text, blocking, created_at) VALUES (?, ?, 'question', 'Which telegraph?', 1, ?)")
    .run(process.env.FACTORY_RUN_ID, process.env.FACTORY_ROLE, new Date().toISOString());
  db.close();
}
out({ type: 'result', subtype: 'success', is_error: false, result: `done: ${prompt.slice(0, 30)}`, num_turns: 2, session_id: sid,
  modelUsage: { 'claude-x': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 1000, cacheCreationInputTokens: 300, costUSD: 0.01 } } });
