// Project name validation.
// Enforces a safe identifier pattern: starts with a letter, then letters/digits/hyphens/underscores.
// Covers all project names in the product vision (SEG, MVA, Kovaad, SLVBankRecon, ChronoLMS).

/** Default project name used when none is specified. */
export const DEFAULT_PROJECT_NAME = 'default'

/**
 * Valid project name pattern: starts with a letter, followed by letters,
 * digits, hyphens, or underscores. 1–64 characters total.
 */
const PROJECT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/**
 * Validate and normalize a project name.
 *
 * @param raw - Input to validate (may come from CLI flag, MCP arg, or env var)
 * @param defaultName - Fallback when raw is undefined (default: DEFAULT_PROJECT_NAME)
 * @returns Normalized (trimmed) project name
 * @throws Error with actionable message when raw is invalid
 */
export function normalizeProjectName(raw: string | undefined, defaultName?: string): string {
  const name = raw?.trim() ?? ''
  if (name.length === 0) {
    return defaultName ?? DEFAULT_PROJECT_NAME
  }
  if (!PROJECT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid project name "${name.slice(0, 64)}". ` +
        'Must start with a letter and contain only letters, digits, hyphens, and underscores (1-64 chars).'
    )
  }
  return name
}
