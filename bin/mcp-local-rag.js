#!/usr/bin/env node
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.resolve(__dirname, '../src/index.ts');

// npx sets INIT_CWD to the original directory; fall back to process.cwd()
const cwd = process.env['INIT_CWD'] || process.cwd();

// Quote args containing spaces to preserve them through shell parsing
const args = process.argv.slice(2).map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ');

execSync(`npx tsx "${srcPath}" ${args}`, { stdio: 'inherit', cwd });
