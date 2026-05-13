#!/usr/bin/env node
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve directory of the current script (bin/mcp-local-rag.js)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve the absolute path to src/index.ts (which is in ../src/index.ts)
const srcPath = path.resolve(__dirname, '../src/index.ts');

// Execute npx tsx with the absolute path
execSync(`npx tsx "${srcPath}" ${process.argv.slice(2).join(' ')}`, { stdio: 'inherit', cwd: __dirname });
