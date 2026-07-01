// RAG Skill and AGENTS.md generation routes

import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ApiConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { projects } from '../db/schema.js'
import { type JwtPayload, requireAuth } from '../middleware/auth.js'

function generateRagSkill(projectName: string, task?: string): string {
  return `# project-rag

## Purpose
Search and retrieve documents from the "${projectName}" project using mcp-local-rag.

## When to Use
- When you need to find information from indexed documents
- When answering questions about project-specific knowledge
- When looking up requirements, specifications, or documentation
${task ? `- Current task: ${task}` : ''}

## Tools Available
- \`search_project_docs(project_name, query, limit)\` - Search for relevant documents
- \`get_project_brief(project_name)\` - Get project overview
- \`requirement_lookup(project_name, requirement)\` - Look up specific requirements
- \`planning_context(project_name, task)\` - Get context for planning

## Usage Pattern

\`\`\`
search_project_docs("${projectName}", "your search query", 5)
\`\`\`

## Examples

### Finding requirements
\`\`\`
requirement_lookup("${projectName}", "authentication requirements")
\`\`\`

### Getting project context
\`\`\`
planning_context("${projectName}", "implement user login feature")
\`\`\`

### General search
\`\`\`
search_project_docs("${projectName}", "how does the API work", 10)
\`\`\`

## Notes
- Always specify the project name: "${projectName}"
- Use specific queries for better results
- Adjust the limit parameter based on how much context you need
`
}

function generateAgentsBlock(projectName: string, repoPath?: string): string {
  const pathNote = repoPath ? `\nRepository path: ${repoPath}` : ''
  return `<!-- LOCAL_RAG_MCP_START -->
## Local Project RAG Rule
Project name: ${projectName}${pathNote}
Before planning, coding, estimating, refactoring, or changing requirements, use the local-project-rag MCP server.
Required call:
planning_context(project_name="${projectName}", task="<current task>")
For exact requirement lookup:
requirement_lookup(project_name="${projectName}", requirement="<question>")
Rules:
- Do not assume undocumented business rules.
- If documentation is missing or conflicting, say so.
- Include source filenames where possible.
- Prefer small, auditable changes.
- Include impacted files and acceptance criteria.
<!-- LOCAL_RAG_MCP_END -->`
}

export function registerSkillRoutes(app: FastifyInstance, config: ApiConfig): void {
  const db = getDb(config.databaseUrl)

  // POST /skill/generate — Generate RAG skill markdown for a project
  app.post('/skill/generate', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as JwtPayload).id
    const { projectName, task } = request.body as {
      projectName: string
      task?: string
    }

    if (!projectName) {
      return reply.code(400).send({ error: 'Bad Request', message: 'projectName is required' })
    }

    // Verify project exists and belongs to user
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.name, projectName), eq(projects.userId, userId)))
      .limit(1)

    if (!project) {
      return reply.code(404).send({ error: 'Not Found', message: 'Project not found' })
    }

    const skillMarkdown = generateRagSkill(projectName, task)

    return { projectName, skillMarkdown }
  })

  // POST /agents/generate — Generate AGENTS.md block for a project
  app.post('/agents/generate', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as JwtPayload).id
    const { projectName, repoPath } = request.body as {
      projectName: string
      repoPath?: string
    }

    if (!projectName) {
      return reply.code(400).send({ error: 'Bad Request', message: 'projectName is required' })
    }

    // Verify project exists and belongs to user
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.name, projectName), eq(projects.userId, userId)))
      .limit(1)

    if (!project) {
      return reply.code(404).send({ error: 'Not Found', message: 'Project not found' })
    }

    const agentsBlock = generateAgentsBlock(projectName, repoPath)

    return { projectName, agentsBlock }
  })
}
