// Mirror new AGENT_BUS.jsonl entries (from Codex, DeepSeek, the Roblox Assistant relay, …)
// into the activity feed so the dashboard shows non-Claude agents too.
import fs from 'node:fs';
import path from 'node:path';
import { kvGet, kvSet, logActivity } from './db.mjs';
import { REPO_ROOT } from './paths.mjs';

const BUS = path.join(REPO_ROOT, 'AGENT_BUS.jsonl');

export function tailBus(db) {
  let size;
  try { size = fs.statSync(BUS).size; } catch { return 0; }
  const stored = kvGet(db, 'bus_offset', null);
  if (stored === null || Number(stored) > size) { kvSet(db, 'bus_offset', size); return 0; }
  const from = Number(stored);
  if (size === from) return 0;
  const buf = Buffer.alloc(size - from);
  const fd = fs.openSync(BUS, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
  const text = buf.toString('utf8');
  const end = text.lastIndexOf('\n');
  if (end < 0) return 0;
  let n = 0;
  for (const line of text.slice(0, end).split('\n')) {
    try {
      const m = JSON.parse(line);
      logActivity(db, { role: m.agent_name, kind: 'bus', summary: `[${m.state}] ${m.task}: ${m.message}` });
      n += 1;
    } catch { /* skip malformed lines */ }
  }
  kvSet(db, 'bus_offset', from + Buffer.byteLength(text.slice(0, end + 1)));
  return n;
}
