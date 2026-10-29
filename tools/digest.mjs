#!/usr/bin/env node
// Print the self-review digest: `node factory/tools/digest.mjs --days 3`
import { openDb } from '../lib/db.mjs';
import { loadConfig } from '../lib/config.mjs';
import { buildDigest } from '../lib/digest.mjs';

const i = process.argv.indexOf('--days');
const days = i > 0 ? Number(process.argv[i + 1]) || 3 : 3;
const db = openDb();
console.log(buildDigest(db, loadConfig(), { days }));
db.close();
