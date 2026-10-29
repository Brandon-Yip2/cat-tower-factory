// Find the Claude Code executable. On Windows `claude` is a .cmd shim that Node can't spawn
// without a shell, so prefer the real claude.exe it points at.
import fs from 'node:fs';
import path from 'node:path';

export function resolveClaude(cfg, env = process.env) {
  const configured = cfg.settings.claudePath || env.FACTORY_CLAUDE;
  if (configured) {
    return configured.endsWith('.mjs') || configured.endsWith('.js')
      ? { cmd: process.execPath, prefix: [configured] }
      : { cmd: configured, prefix: [] };
  }
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const exe = path.join(d, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(exe)) return { cmd: exe, prefix: [] };
    if (process.platform === 'win32') {
      const shim = path.join(d, 'claude.cmd');
      if (fs.existsSync(shim)) {
        const m = /"%dp0%\\([^"]+claude\.exe)"/i.exec(fs.readFileSync(shim, 'utf8'));
        if (m) {
          const target = path.join(d, m[1]);
          if (fs.existsSync(target)) return { cmd: target, prefix: [] };
        }
      }
    }
  }
  return { cmd: 'claude', prefix: [], shell: true };
}
