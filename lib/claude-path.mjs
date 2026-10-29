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
        const text = fs.readFileSync(shim, 'utf8');
        const exe = /"%dp0%\\([^"]+claude\.exe)"/i.exec(text);
        if (exe && fs.existsSync(path.join(d, exe[1]))) return { cmd: path.join(d, exe[1]), prefix: [] };
        const js = /"%dp0%\\([^"]+\.(?:c|m)?js)"/i.exec(text);
        if (js && fs.existsSync(path.join(d, js[1]))) return { cmd: process.execPath, prefix: [path.join(d, js[1])] };
      }
    }
  }
  // Never fall back to a shell: run arguments carry agent-written text.
  throw new Error('Claude Code executable not found on PATH; set settings.claudePath in factory/factory.config.json');
}
