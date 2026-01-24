const builtinModules = require('module').builtinModules

// Include both 'fs' and 'node:fs' style imports
const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]

module.exports = {
  src: 'src',
  ignoredDependencies: nodeBuiltins,
  testMatch: [
    '**/__tests__/**/*.?(m|c)[jt]s?(x)',
    '**/?(*.)+(spec|specs|test|tests).?(m|c)[jt]s?(x)',
  ],
}
