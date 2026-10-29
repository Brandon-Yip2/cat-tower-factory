// The Cat Tower Game Bible: docs/bible/*.md, one tab per file (name order), plus changelog.md.
// A line `<!-- include: docs/... -->` pulls in another Markdown file under docs/ (e.g. generated game data).
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.mjs';

const BIBLE_DIR = path.join(REPO_ROOT, 'docs', 'bible');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const INCLUDE = /^<!--\s*include:\s*(\S+)\s*-->\s*$/gm;

function expand(text, depth = 0) {
  if (depth > 2) return text;
  return text.replace(INCLUDE, (line, rel) => {
    const full = path.resolve(REPO_ROOT, rel);
    if (!full.startsWith(DOCS_DIR + path.sep) || !full.endsWith('.md') || !fs.existsSync(full)) return `> Missing include: ${rel}`;
    return expand(fs.readFileSync(full, 'utf8'), depth + 1);
  });
}

function section(file) {
  const raw = fs.readFileSync(path.join(BIBLE_DIR, file), 'utf8');
  const title = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim() || file.replace(/^\d+-|\.md$/g, '');
  return { id: file.replace(/^\d+-|\.md$/g, ''), file: `docs/bible/${file}`, title, markdown: expand(raw),
    updated: fs.statSync(path.join(BIBLE_DIR, file)).mtime.toISOString() };
}

export function readBible() {
  if (!fs.existsSync(BIBLE_DIR)) return { sections: [], changelog: null };
  const files = fs.readdirSync(BIBLE_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  return {
    sections: files.filter((f) => f !== 'changelog.md').map(section),
    changelog: files.includes('changelog.md') ? section('changelog.md') : null,
  };
}
