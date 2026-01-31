#!/usr/bin/env node

/**
 * Unused exports checker script
 * Filters out "used in module" from ts-prune output to show only truly unused exports
 */

const { execSync } = require('child_process')

try {
  // Run ts-prune
  const output = execSync(
    'npx ts-prune --project tsconfig.json --ignore "src/index.ts|__tests__|test|vitest|src/parser/custom"',
    { encoding: 'utf8' }
  )

  // Process each line
  const lines = output.split('\n').filter(line => line.trim())
  const results = {
    usedInModule: [],
    trulyUnused: [],
    total: 0
  }

  for (const line of lines) {
    if (line.includes(' - ')) {
      results.total++
      if (line.includes('(used in module)')) {
        results.usedInModule.push(line)
      } else {
        results.trulyUnused.push(line)
      }
    }
  }

  // Display results
  console.log('=== Unused Exports Analysis ===\n')
  
  if (results.trulyUnused.length > 0) {
    console.log(`🔴 Truly unused exports: ${results.trulyUnused.length}`)
    console.log('─'.repeat(50))
    results.trulyUnused.forEach(line => console.log(line))
    console.log('')
  } else {
    console.log('✅ No truly unused exports found\n')
  }

  if (results.usedInModule.length > 0) {
    console.log(`⚠️ Used only in module (unnecessary exports): ${results.usedInModule.length}`)
    console.log('─'.repeat(50))
    results.usedInModule.forEach(line => console.log(line))
    console.log('')
  } else {
    console.log('✅ No unnecessary internal exports found\n')
  }

  // Summary
  console.log('=== Summary ===')
  console.log(`Total unnecessary exports: ${results.total}`)
  console.log(`├── Truly unused: ${results.trulyUnused.length} (delete immediately)`)
  console.log(`└── Used in module only: ${results.usedInModule.length} (remove export keyword)`)

  // Exit code
  process.exit(results.trulyUnused.length > 0 ? 1 : 0)

} catch (error) {
  console.error('Error occurred:', error.message)
  process.exit(1)
}
