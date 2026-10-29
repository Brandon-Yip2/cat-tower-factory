// Token use of interactive sessions, read incrementally from their transcripts (factory runs
// get exact totals from the stream-json result instead).
import fs from 'node:fs';
import { kvGet, kvSet } from './db.mjs';

export function usageSweep(db) {
  const runs = db.prepare(`SELECT id, transcript_path, transcript_offset FROM runs WHERE kind = 'interactive'
    AND transcript_path IS NOT NULL AND (status IN ('running','idle') OR ended_at >= ?)`)
    .all(new Date(Date.now() - 3600_000).toISOString());
  for (const r of runs) {
    let fd;
    try {
      const size = fs.statSync(r.transcript_path).size;
      if (size <= r.transcript_offset) continue;
      fd = fs.openSync(r.transcript_path, 'r');
      const len = Math.min(size - r.transcript_offset, 16 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, r.transcript_offset);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) continue;
      const seenKey = `usage_last:${r.id}`;
      let lastId = kvGet(db, seenKey, '');
      const t = { in: 0, out: 0, cr: 0, cw: 0 };
      for (const line of text.slice(0, end).split('\n')) {
        if (!line.includes('"usage"')) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const m = j.message;
        if (j.type !== 'assistant' || !m?.usage || m.id === lastId) continue;
        lastId = m.id;
        t.in += m.usage.input_tokens || 0; t.out += m.usage.output_tokens || 0;
        t.cr += m.usage.cache_read_input_tokens || 0; t.cw += m.usage.cache_creation_input_tokens || 0;
      }
      kvSet(db, seenKey, lastId);
      db.prepare(`UPDATE runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cache_read = cache_read + ?,
        cache_write = cache_write + ?, transcript_offset = ? WHERE id = ?`)
        .run(t.in, t.out, t.cr, t.cw, r.transcript_offset + Buffer.byteLength(text.slice(0, end + 1)), r.id);
    } catch { /* transcript moved or unreadable; try again next sweep */ } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
