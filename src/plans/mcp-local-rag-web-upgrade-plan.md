

Recommendation: Use TypeScript if mcp-local-rag is close enough, but do not force it into a full app immediately. Keep the core MCP/RAG in TypeScript, and add a small management UI/backend around it.

Rationale:

Choice	Verdict
Fork mcp-local-rag and extend in TypeScript
TypeScript backend + simple UI	Best practical path now

Updated direction

Use this architecture:

mcp-local-rag fork
   ↓
Add project namespaces
   ↓
Add ingestion API / CLI
   ↓
Add local metadata DB
   ↓
Add small web UI
   ↓
Add Cursor config + AGENTS.md automation

Recommended stack

Language: TypeScript
Runtime: Node.js
Backend/API: Fastify or Hono
Frontend: Next.js or simple Vite React
Vector DB: LanceDB if TS support works cleanly, otherwise keep existing store first
Metadata DB: SQLite with Drizzle ORM
MCP: Existing TypeScript MCP SDK
Auth: Local username/email + password, or single-user token first

Best staged path

Stage 1: Keep existing project working

Do not change vector DB yet.

Add only:

project_name
metadata filters
project-scoped search
new MCP tools

MCP tools:

search_project_docs(project_name, query, limit)
get_project_brief(project_name)
requirement_lookup(project_name, requirement)
planning_context(project_name, task)
list_projects()

Stage 2: Add local management API

Add:

POST /projects
GET /projects
POST /projects/:id/files
POST /projects/:id/index
POST /search

Use SQLite for:

users
projects
files
index_jobs
settings

Stage 3: Add UI

Use Next.js/Vite because the codebase is already TS.

Screens:

Login
Projects
Upload
Index/Reindex
Search
MCP Setup
Skill Setup
AGENTS.md Setup

Stage 4: Add automation

Buttons:

Add MCP server to Cursor
Generate RAG Skill
Update AGENTS.md

Stage 5: Upgrade vector DB only if needed

Start with the existing vector layer.

Move to LanceDB only after:

project namespaces work
upload works
search works
Cursor MCP works

My final call

For your case:

Start with mcp-local-rag in TypeScript.
Do not rewrite.
Add project namespace first.
Add UI/API second.
Delay LanceDB migration.

This reduces risk and gets you a working tool faster.

Decision / Action: Proceed with TypeScript fork of mcp-local-rag, but build in stages and avoid vector DB migration until the project workflow is stable.