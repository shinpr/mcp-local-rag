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
      'Search ingested documents. Your query words are matched exactly (keyword search). Your query meaning is matched semantically (vector search). Preserve specific terms from the user. Add context if the query is ambiguous. Results include score (0 = most relevant, higher = less relevant).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Include specific terms and add context if needed.',
        },
        limit: {
          type: 'number',
          description:
            'Maximum number of results to return (default: 10). Recommended: 5 for precision, 10 for balance, 20 for broad exploration.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ingest_file',
    description:
      'Ingest a document file (PDF, DOCX, TXT, MD) into the vector database for semantic search. File path must be an absolute path. Supports re-ingestion to update existing documents.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Absolute path to the file to ingest. Example: "/Users/user/documents/manual.pdf"',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'ingest_data',
    description:
      'Ingest content as a string, not from a file. Use for: fetched web pages (format: html), copied text (format: text), or markdown strings (format: markdown). The source identifier enables re-ingestion to update existing content. For files on disk, use ingest_file instead.',
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
              description: 'Content format: "text", "html", or "markdown"',
            },
          },
          required: ['source', 'format'],
        },
      },
      required: ['content', 'metadata'],
    },
  },
  {
    name: 'delete_file',
    description:
      'Delete a previously ingested file or data from the vector database. Use filePath for files ingested via ingest_file, or source for data ingested via ingest_data. Either filePath or source must be provided.',
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
      'List all files in BASE_DIR (PDF, DOCX, TXT, MD) and show which are ingested into the vector database. Also lists any other ingested items (web pages, clipboard content, etc.) that are outside BASE_DIR.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description:
      'Get system status including total documents, total chunks, database size, and configuration information.',
    inputSchema: { type: 'object', properties: {} },
  },
]
