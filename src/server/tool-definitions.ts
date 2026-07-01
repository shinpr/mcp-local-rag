// MCP tool schema definitions for RAGServer

import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/**
 * All MCP tool definitions for the RAG server.
 * These are purely declarative schema objects that describe
 * what tools exist and their input parameters.
 */
export const toolDefinitions: Tool[] = [
  {
    name: 'query_documents',
    description:
      'Search ingested documents with hybrid keyword + semantic matching. Returns results sorted by relevance, each with filePath, chunkIndex, text, fileTitle, score (0 = best, higher = worse), and source (for ingest_data items).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query. Preserve specific user terms (for keyword match); add context when the query is vague (for semantic match).',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 20,
          description:
            'Max results (default 10, range 1-20). Lower favors precision, higher recall.',
        },
        scope: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description:
            'Optional absolute path prefix(es) — one string or a list (unioned) — restricting results to a filePath equal to or under a prefix. "/docs/api" matches "/docs/api/auth.md" but not "/docs/apiv2". Must be absolute (server OS style); a relative prefix matches nothing — derive one from a filePath returned by an earlier query, or omit scope.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ingest_file',
    description:
      'Ingest a document file (PDF, DOCX, TXT, MD) into the vector database. Path must be absolute; re-ingesting the same path replaces its existing data. Returns { filePath, chunkCount, timestamp, fileTitle, projectName }.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Absolute path to the file to ingest. Example: "/Users/user/documents/manual.pdf"',
        },
        visual: {
          type: 'boolean',
          description: 'Run VLM captioning on figure pages (PDF only; default false).',
        },
        visualQuality: {
          type: 'string',
          enum: ['fast', 'quality'],
          default: 'fast',
          description:
            'VLM profile when visual is true (default "fast"). "quality" is more accurate on figures with in-image text but much heavier and slower. Ignored when visual is false.',
        },
        projectName: {
          type: 'string',
          description:
            'Project name namespace for indexing (default: DEFAULT_PROJECT env or "default"). Must start with a letter, contain only letters/digits/hyphens/underscores.',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'ingest_data',
    description:
      'Ingest in-memory content as a string (use ingest_file for files on disk). The source identifier enables re-ingestion to update existing content. Returns { filePath, chunkCount, timestamp, fileTitle, projectName }.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to ingest (text, HTML, or Markdown)',
        },
        metadata: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description:
                'Source identifier. For web pages, use the URL (e.g., "https://example.com/page"). For other content, use URL-scheme format: "{type}://{date}" or "{type}://{date}/{detail}". Examples: "clipboard://2024-12-30", "chat://2024-12-30/project-discussion", "note://2024-12-30/meeting".',
            },
            format: {
              type: 'string',
              enum: ['text', 'html', 'markdown'],
              description:
                'Content format: text (plain/copied text), html (fetched web pages), or markdown.',
            },
          },
          required: ['source', 'format'],
        },
        projectName: {
          type: 'string',
          description:
            'Project name namespace for indexing (default: DEFAULT_PROJECT env or "default"). Must start with a letter, contain only letters/digits/hyphens/underscores.',
        },
      },
      required: ['content', 'metadata'],
    },
  },
  {
    name: 'delete_file',
    description:
      'Delete a previously ingested file or data from the vector database. Use filePath for files ingested via ingest_file, or source for data ingested via ingest_data. Either filePath or source must be provided. Returns deleted (operation succeeded), removedChunks, and existed (whether anything was actually present).',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Absolute path to the file (for ingest_file). Example: "/Users/user/documents/manual.pdf"',
        },
        source: {
          type: 'string',
          description:
            'Source identifier used in ingest_data. Examples: "https://example.com/page", "clipboard://2024-12-30"',
        },
      },
    },
  },
  {
    name: 'list_files',
    description:
      'List supported files (PDF, DOCX, TXT, MD) under the configured base directories and whether each is ingested. Returns { baseDirs, files, sources }; sources holds ingested items outside the base dirs (web pages, clipboard, etc.).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description:
      'Get index status: { documentCount, chunkCount, memoryUsage (MB), uptime (s), ftsIndexEnabled, searchMode }.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_chunk_neighbors',
    description:
      'Read the chunks immediately before and after a query_documents result, in the same document, for more surrounding context. Pass chunkIndex from the result plus exactly one of filePath (ingest_file) or source (ingest_data). Returns the target chunk (isTarget: true) and its neighbors, ascending by chunkIndex; an out-of-range chunkIndex returns []. Defaults: before=2, after=2 (max 50 each).',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Absolute path to the file (for ingest_file documents). Provide exactly one of filePath or source. Example: "/Users/user/documents/manual.pdf".',
        },
        source: {
          type: 'string',
          description:
            'Source identifier (for ingest_data documents). Provide exactly one of filePath or source. Examples: "https://example.com/page", "clipboard://2024-12-30".',
        },
        chunkIndex: {
          type: 'number',
          description: 'Zero-based target chunk index (non-negative integer).',
        },
        before: {
          type: 'number',
          description: 'Number of chunks to retrieve before the target (0–50, default 2).',
        },
        after: {
          type: 'number',
          description: 'Number of chunks to retrieve after the target (0–50, default 2).',
        },
      },
      required: ['chunkIndex'],
    },
  },
  {
    name: 'search_project_docs',
    description:
      'Search documents within a specific project namespace. Returns project-scoped results sorted by relevance, each with filePath, chunkIndex, text, fileTitle, score, and projectName.',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: 'Project name to search within (required).',
        },
        query: {
          type: 'string',
          description: 'Search query.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 20,
          description: 'Max results (default 10, range 1-20).',
        },
      },
      required: ['project_name', 'query'],
    },
  },
  {
    name: 'list_projects',
    description:
      'List all indexed projects with document and chunk counts. Returns array of { projectName, documentCount, chunkCount }.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_project_brief',
    description:
      'Get a project overview by searching for broad context (architecture, requirements, summary). Returns top matching chunks with source filenames.',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: 'Project name (required).',
        },
      },
      required: ['project_name'],
    },
  },
  {
    name: 'requirement_lookup',
    description:
      'Look up a specific requirement within a project. Returns the most relevant chunks matching the requirement text, emphasizing exact term matches.',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: 'Project name (required).',
        },
        requirement: {
          type: 'string',
          description: 'Requirement text to search for (required).',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 20,
          description: 'Max results (default 8).',
        },
      },
      required: ['project_name', 'requirement'],
    },
  },
  {
    name: 'planning_context',
    description:
      'Get structured planning context for a task within a project. Searches for project overview and task-relevant requirements. Returns structured markdown with sources — does not invent requirements.',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: 'Project name (required).',
        },
        task: {
          type: 'string',
          description: 'Task description to gather context for (required).',
        },
      },
      required: ['project_name', 'task'],
    },
  },
]
