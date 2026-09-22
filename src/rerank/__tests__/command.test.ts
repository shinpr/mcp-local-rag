import { describe, expect, it } from 'vitest'
import { buildRerankArgv, parseRerankCommand } from '../command.js'

describe('parseRerankCommand', () => {
  it('should split the executable and unquoted arguments', () => {
    expect(parseRerankCommand('jev-reranker --query {query} --top {top}')).toEqual({
      executable: 'jev-reranker',
      args: ['--query', '{query}', '--top', '{top}'],
    })
  })

  it('should return an executable with no arguments for a bare command', () => {
    expect(parseRerankCommand('jev-reranker')).toEqual({ executable: 'jev-reranker', args: [] })
  })

  it('should ignore surrounding and repeated whitespace', () => {
    expect(parseRerankCommand('  jev-reranker \t --top-field\n score  ')).toEqual({
      executable: 'jev-reranker',
      args: ['--top-field', 'score'],
    })
  })

  it('should group single- and double-quoted text without passing the quotes', () => {
    expect(
      parseRerankCommand(`"/path with spaces/reranker" --label 'two words' --model="large model"`)
    ).toEqual({
      executable: '/path with spaces/reranker',
      args: ['--label', 'two words', '--model=large model'],
    })
  })

  it('should preserve empty quoted arguments and literal backslashes', () => {
    expect(parseRerankCommand(`"C:\\Program Files\\reranker.exe" '' ""`)).toEqual({
      executable: 'C:\\Program Files\\reranker.exe',
      args: ['', ''],
    })
  })

  it('should reject an empty executable and unterminated quotes', () => {
    expect(parseRerankCommand('')).toBeUndefined()
    expect(parseRerankCommand('   \t ')).toBeUndefined()
    expect(parseRerankCommand(`'' --query {query}`)).toBeUndefined()
    expect(parseRerankCommand(`reranker "unterminated`)).toBeUndefined()
    expect(parseRerankCommand(`reranker 'unterminated`)).toBeUndefined()
  })
})

describe('buildRerankArgv', () => {
  it('should render custom flag names, positional values, repeated values, and embedded values', () => {
    expect(
      buildRerankArgv(
        {
          executable: 'jev-reranker',
          args: ['--prompt', '{query}', '--limit={top}', '{query}', '{top}'],
        },
        'cats',
        3
      )
    ).toEqual(['--prompt', 'cats', '--limit=3', 'cats', '3'])
  })

  it('should not append query or top when the template omits them', () => {
    expect(
      buildRerankArgv({ executable: 'reranker', args: ['--model', 'base'] }, 'cats', 3)
    ).toEqual(['--model', 'base'])
  })

  it('should keep a query containing whitespace and shell metacharacters in one element', () => {
    const query = 'cats; rm -rf / && echo "$(whoami)" | tee /tmp/x'
    const argv = buildRerankArgv(
      { executable: 'reranker', args: ['--prompt={query}', '--limit', '{top}'] },
      query,
      1
    )

    expect(argv).toEqual([`--prompt=${query}`, '--limit', '1'])
  })

  it('should replace only placeholders present in the original template', () => {
    expect(
      buildRerankArgv(
        { executable: 'reranker', args: ['{query}', '{top}', '{unknown}'] },
        'literal {top} and {query} $& $$',
        2
      )
    ).toEqual(['literal {top} and {query} $& $$', '2', '{unknown}'])
  })

  it('should preserve an empty or whitespace-only query as one element', () => {
    expect(
      buildRerankArgv({ executable: 'reranker', args: ['before', '{query}', 'after'] }, '   ', 2)
    ).toEqual(['before', '   ', 'after'])
  })
})
