import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { embeddingSnapshotPath } from '../../embedder/embedding-snapshot.js'

const TEST_ROOT = resolve('./tmp/test-ingest-embedding-reuse-process')
const DB_PATH = join(TEST_ROOT, 'db')
const SOURCE_PATH = join(TEST_ROOT, 'docs', 'guide.md')
const PROJECT_ROOT = resolve('.')
const INGEST_MODULE = pathToFileURL(resolve(PROJECT_ROOT, 'src/cli/ingest.ts')).href

interface ProcessResult {
  code: number | null
  stderr: string
  stdout: string
}

function runIngestProcess(): ProcessResult {
  const source = `
    import { readFile } from 'node:fs/promises';
    import { ingestSingleFile } from ${JSON.stringify(INGEST_MODULE)};
    const dbPath = process.env['EMBED_REUSE_TEST_DB'];
    const filePath = process.env['EMBED_REUSE_TEST_SOURCE'];
    const content = await readFile(filePath, 'utf8');
    const inferred = [];
    const mutations = [];
    const stableText = 'The same document section remains unchanged and long enough to be a complete stored chunk.';
    const newText = 'A newly edited section contains additional useful information about the updated document.';
    const embedder = {
      getComputationIdentity: async () => ({ fingerprint: '${'a'.repeat(64)}', dimension: 3 }),
      embedBatch: async (texts, role) => {
        inferred.push({ role: role ?? null, texts: [...texts] });
        return texts.map((text) => [text.length / 100, role === 'document' ? 0.2 : 0.1, 0.3]);
      },
    };
    const chunker = {
      async chunkText(text, documentEmbedder) {
        if (text.includes('zero chunks')) return [];
        const sentenceInputs = ['The unchanged sentence remains here.'];
        if (text.includes('new sentence')) sentenceInputs.push('The new sentence changes here.');
        await documentEmbedder.embedBatch(sentenceInputs);
        const chunks = [{ index: 0, text: stableText, sourceStart: 0, sourceEnd: stableText.length }];
        if (text.includes('new sentence')) {
          chunks.push({ index: 1, text: newText, sourceStart: 1, sourceEnd: text.length });
        }
        return chunks;
      },
    };
    const parser = {
      validateFilePath: async () => undefined,
      validateFileSize: () => undefined,
      parseFile: async (path) => ({ content: await readFile(path, 'utf8'), title: null }),
    };
    const vectorStore = {
      deleteChunks: async () => { mutations.push('delete'); return 0; },
      insertChunks: async () => {
        mutations.push('insert');
        if (content.includes('fail insertion')) throw new Error('insertion failed');
      },
    };
    await ingestSingleFile(filePath, { dbPath, parser, chunker, embedder, vectorStore }, { images: false });
    process.stdout.write(JSON.stringify({ inferred, mutations }));
  `
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source],
    {
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
      timeout: 30_000,
      env: {
        ...process.env,
        EMBED_REUSE_TEST_DB: DB_PATH,
        EMBED_REUSE_TEST_SOURCE: SOURCE_PATH,
      },
    }
  )
  return { code: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
}

describe('CLI ingestion embedding reuse across process restarts', () => {
  beforeAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(join(TEST_ROOT, 'docs'), { recursive: true })
    writeFileSync(SOURCE_PATH, 'The original source contains the unchanged sentence.')
  })

  afterAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('loads the previous disk snapshot and infers only edited sentence and final chunk inputs', () => {
    const first = runIngestProcess()
    expect(first.code, first.stderr).toBe(0)
    expect(existsSync(embeddingSnapshotPath(DB_PATH, SOURCE_PATH))).toBe(true)
    expect(JSON.parse(first.stdout)).toEqual({
      inferred: [
        { role: null, texts: ['The unchanged sentence remains here.'] },
        {
          role: 'document',
          texts: [
            'The same document section remains unchanged and long enough to be a complete stored chunk.',
          ],
        },
      ],
      mutations: ['delete', 'insert'],
    })

    writeFileSync(
      SOURCE_PATH,
      'The original source contains the unchanged sentence and a new sentence.'
    )
    const restarted = runIngestProcess()

    expect(restarted.code, restarted.stderr).toBe(0)
    expect(JSON.parse(restarted.stdout)).toEqual({
      inferred: [
        { role: null, texts: ['The new sentence changes here.'] },
        {
          role: 'document',
          texts: [
            'A newly edited section contains additional useful information about the updated document.',
          ],
        },
      ],
      mutations: ['delete', 'insert'],
    })

    const published = readFileSync(embeddingSnapshotPath(DB_PATH, SOURCE_PATH))
    writeFileSync(SOURCE_PATH, 'zero chunks')
    const empty = runIngestProcess()
    expect(empty.code, empty.stderr).toBe(0)
    expect(JSON.parse(empty.stdout)).toEqual({ inferred: [], mutations: [] })
    expect(readFileSync(embeddingSnapshotPath(DB_PATH, SOURCE_PATH))).toEqual(published)

    writeFileSync(SOURCE_PATH, 'fail insertion after successful preparation')
    const failedInsert = runIngestProcess()
    expect(failedInsert.code).not.toBe(0)
    expect(readFileSync(embeddingSnapshotPath(DB_PATH, SOURCE_PATH))).toEqual(published)
  })
})
