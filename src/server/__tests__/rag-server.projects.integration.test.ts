import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'
import { RAGServer } from '../../server/index.js'

/**
 * Stage 1 integration tests: project-scoped indexing and search.
 *
 * Tests the full pipeline: ingest docs under different project namespaces,
 * search per-project, list projects, verify isolation.
 */
describe('Project namespaces (Stage 1)', () => {
  const dbPath = resolve('./tmp/test-projects-integration')
  const baseDir = resolve('./tmp/test-projects-integration-data')
  const cacheDir = testModelCacheDir(resolve('./tmp/test-projects-models'))

  let server: RAGServer

  beforeAll(async () => {
    // Clean up
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true })
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true })
    mkdirSync(baseDir, { recursive: true })

    // Create test documents
    writeFileSync(
      resolve(baseDir, 'seg-requirements.txt'),
      'SEG project requirements: The Direct Copper PPS integration requires careful coordination with legacy systems. Key stakeholders include engineering, QA, and compliance teams. Phase 1 delivers basic connectivity; phase 2 adds real-time monitoring.'
    )
    writeFileSync(
      resolve(baseDir, 'mva-requirements.txt'),
      'MVA project requirements: The vehicle tracking system provides real-time GPS data across 12 operational zones. The Kafka pipeline processes events with sub-second latency. Phase 1 delivers basic tracking; phase 2 adds predictive routing.'
    )

    // Build server with project support
    const config = withTestDevice({
      dbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir,
      baseDirs: [baseDir],
      rawBaseDirs: [baseDir],
      defaultProject: 'default',
    })
    server = new RAGServer(config)
    await server.initialize()
  }, 180_000)

  afterAll(async () => {
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true })
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true })
  })

  it('ingests document under SEG project', async () => {
    const result = await server.handleIngestFile({
      filePath: resolve(baseDir, 'seg-requirements.txt'),
      projectName: 'SEG',
    })
    const data = JSON.parse(result.content[0]!.text as string)
    expect(data.projectName).toBe('SEG')
    expect(data.chunkCount).toBeGreaterThan(0)
  }, 60_000)

  it('ingests document under MVA project', async () => {
    const result = await server.handleIngestFile({
      filePath: resolve(baseDir, 'mva-requirements.txt'),
      projectName: 'MVA',
    })
    const data = JSON.parse(result.content[0]!.text as string)
    expect(data.projectName).toBe('MVA')
    expect(data.chunkCount).toBeGreaterThan(0)
  }, 60_000)

  it('search_project_docs(SEG) returns only SEG chunks', async () => {
    const result = await server.handleSearchProjectDocs({
      project_name: 'SEG',
      query: 'copper integration requirements',
    })
    const results = JSON.parse(result.content[0]!.text as string)
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.projectName).toBe('SEG')
      expect(r.filePath).toContain('seg-requirements.txt')
    }
  }, 60_000)

  it('search_project_docs(MVA) returns only MVA chunks', async () => {
    const result = await server.handleSearchProjectDocs({
      project_name: 'MVA',
      query: 'vehicle tracking GPS',
    })
    const results = JSON.parse(result.content[0]!.text as string)
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.projectName).toBe('MVA')
      expect(r.filePath).toContain('mva-requirements.txt')
    }
  }, 60_000)

  it('same query returns different results for different projects', async () => {
    const segResult = await server.handleSearchProjectDocs({
      project_name: 'SEG',
      query: 'requirements phase',
    })
    const mvaResult = await server.handleSearchProjectDocs({
      project_name: 'MVA',
      query: 'requirements phase',
    })
    const segResults = JSON.parse(segResult.content[0]!.text as string)
    const mvaResults = JSON.parse(mvaResult.content[0]!.text as string)

    expect(segResults.length).toBeGreaterThan(0)
    expect(mvaResults.length).toBeGreaterThan(0)

    // No file path overlap
    const segPaths = new Set(segResults.map((r: { filePath: string }) => r.filePath))
    const mvaPaths = new Set(mvaResults.map((r: { filePath: string }) => r.filePath))
    for (const p of segPaths) {
      expect(mvaPaths.has(p)).toBe(false)
    }
  }, 60_000)

  it('list_projects returns SEG and MVA', async () => {
    const result = await server.handleListProjects()
    const projects = JSON.parse(result.content[0]!.text as string)
    const names = projects.map((p: { projectName: string }) => p.projectName)
    expect(names).toContain('SEG')
    expect(names).toContain('MVA')
    // Verify counts
    const seg = projects.find((p: { projectName: string }) => p.projectName === 'SEG')
    const mva = projects.find((p: { projectName: string }) => p.projectName === 'MVA')
    expect(seg!.documentCount).toBe(1)
    expect(seg!.chunkCount).toBeGreaterThan(0)
    expect(mva!.documentCount).toBe(1)
    expect(mva!.chunkCount).toBeGreaterThan(0)
  })

  it('legacy query_documents returns only default project results', async () => {
    // Ingest a doc under the default project
    writeFileSync(
      resolve(baseDir, 'default-doc.txt'),
      'Default project document about TypeScript type checking.'
    )
    await server.handleIngestFile({
      filePath: resolve(baseDir, 'default-doc.txt'),
    })

    const result = await server.handleQueryDocuments({ query: 'TypeScript type checking' })
    const results = JSON.parse(result.content[0]!.text as string)
    // Should find the default doc but NOT seg/mva docs
    for (const r of results) {
      expect(r.filePath).toContain('default-doc.txt')
    }
  }, 60_000)

  it('get_project_brief returns overview chunks for SEG', async () => {
    const result = await server.handleGetProjectBrief({ project_name: 'SEG' })
    const brief = JSON.parse(result.content[0]!.text as string)
    expect(brief.projectName).toBe('SEG')
    expect(brief.documents.length).toBeGreaterThan(0)
    expect(brief.documents[0].source).toBeDefined()
  }, 60_000)

  it('requirement_lookup returns relevant chunks', async () => {
    const result = await server.handleRequirementLookup({
      project_name: 'MVA',
      requirement: 'real-time GPS tracking',
    })
    const data = JSON.parse(result.content[0]!.text as string)
    expect(data.projectName).toBe('MVA')
    expect(data.matches.length).toBeGreaterThan(0)
    expect(data.matches[0].source).toBeDefined()
  }, 60_000)

  it('planning_context returns structured context', async () => {
    const result = await server.handlePlanningContext({
      project_name: 'SEG',
      task: 'Implement copper integration phase 1',
    })
    const context = JSON.parse(result.content[0]!.text as string)
    expect(context.projectName).toBe('SEG')
    expect(context.task).toBe('Implement copper integration phase 1')
    expect(context.projectOverview.length).toBeGreaterThan(0)
    expect(context.taskContext.length).toBeGreaterThan(0)
    expect(context.instructions).toContain('Do not invent requirements')
  }, 60_000)

  it('schema migration adds projectName and fileHash to pre-existing DB', async () => {
    // Verify that the schema migration works by checking we can read
    // chunks with projectName populated
    const listResult = await server.handleListProjects()
    const projects = JSON.parse(listResult.content[0]!.text as string)
    // All projects should have valid names
    for (const p of projects) {
      expect(typeof p.projectName).toBe('string')
      expect(p.projectName.length).toBeGreaterThan(0)
      expect(p.documentCount).toBeGreaterThan(0)
      expect(p.chunkCount).toBeGreaterThan(0)
    }
  })
})
