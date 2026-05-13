#!/usr/bin/env node
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.resolve(__dirname, '../src/index.ts');

execSync(`npx tsx "${srcPath}" ${process.argv.slice(2).join(' ')}`, { stdio: 'inherit' });
