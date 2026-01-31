import { readFile } from 'node:fs/promises'

export async function parseFile(filePath: string): Promise<string> {
  return await readFile(filePath, 'utf-8')
}

export default parseFile
