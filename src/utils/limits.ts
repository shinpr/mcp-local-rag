// Cross-cutting numeric limits shared across CLI and MCP server entry points.
// Dependency-free leaf module so any layer can import it without coupling.

/**
 * Maximum directory recursion depth when scanning a base directory or ingest
 * target. Applied identically by the CLI `ingest`/`list` walkers and the MCP
 * server's `list_files` scan so the boundary is consistent everywhere.
 */
export const MAX_SCAN_DEPTH = 10

/**
 * Default maximum file size for ingestion, in bytes (100 MB). Used when neither
 * the CLI `--max-file-size` flag nor the `MAX_FILE_SIZE` env var is provided.
 */
export const DEFAULT_MAX_FILE_SIZE = 104_857_600

/**
 * Hard upper bound (inclusive) for the configurable max file size, in bytes
 * (500 MB). Values above this are rejected by `validateMaxFileSize`.
 */
export const MAX_FILE_SIZE_LIMIT = 524_288_000
