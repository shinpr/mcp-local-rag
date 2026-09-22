/** An executable and the arguments configured alongside it. */
export interface RerankCommand {
  /** Program to spawn. Must name a directly executable file, not a shim. */
  executable: string
  /** Argument templates configured by the operator. */
  args: string[]
}

type RerankQuote = "'" | '"'

function consumeQuotedCharacter(
  character: string,
  quote: RerankQuote,
  current: string
): { current: string; quote: RerankQuote | undefined } {
  if (character === quote) {
    return { current, quote: undefined }
  }
  return { current: current + character, quote }
}

/**
 * Tokenizes the command with a small, platform-independent quoting grammar.
 * Whitespace separates tokens outside matching single or double quotes; quote
 * characters group text and are removed. Everything else, including
 * backslashes and shell metacharacters, stays literal.
 *
 * Returns undefined when the string carries no executable or has an unmatched
 * quote.
 */
export function parseRerankCommand(command: string): RerankCommand | undefined {
  const tokens: string[] = []
  let current = ''
  let tokenStarted = false
  let quote: RerankQuote | undefined

  for (const character of command) {
    if (quote !== undefined) {
      const consumed = consumeQuotedCharacter(character, quote, current)
      current = consumed.current
      quote = consumed.quote
      continue
    }

    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
      continue
    }

    if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(current)
        current = ''
        tokenStarted = false
      }
      continue
    }

    current += character
    tokenStarted = true
  }

  if (quote !== undefined) {
    return undefined
  }
  if (tokenStarted) {
    tokens.push(current)
  }

  const [executable, ...args] = tokens
  return executable === undefined || executable.length === 0 ? undefined : { executable, args }
}

/**
 * Replaces runtime placeholders independently in each configured argument.
 * `replace` scans only the original template, so placeholder-shaped query text
 * is not interpreted recursively.
 */
export function buildRerankArgv(command: RerankCommand, query: string, top: number): string[] {
  return command.args.map((argument) =>
    argument.replace(/\{(?:query|top)\}/g, (placeholder) =>
      placeholder === '{query}' ? query : String(top)
    )
  )
}
