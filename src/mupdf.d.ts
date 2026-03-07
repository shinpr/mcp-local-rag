// Type declarations for mupdf package
// Required because tsconfig uses "module": "commonjs" which does not resolve
// the "exports" field in mupdf's package.json. This re-exports the official types.
declare module 'mupdf' {
  export * from 'mupdf/dist/mupdf'
}
