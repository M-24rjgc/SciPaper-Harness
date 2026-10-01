import { defineConfig } from 'tsdown'
import ts from 'typescript'

export default defineConfig([{
  entry: { index: 'lib/types/index.js', protocol: 'lib/types/protocol.js', schemas: 'lib/types/schemas.js', auth: 'lib/types/auth.js' },
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
}, {
  // The remote host receives this single file over SSH; it cannot resolve the
  // workstation's workspace packages or sibling build chunks.
  entry: { helper: 'src/helper-entry.ts' },
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
  noExternal: [/.*/], outputOptions: { inlineDynamicImports: true },
  plugins: [{
    name: 'remote-helper-decorators',
    renderChunk(code) {
      // Bundled workspace modules retain legacy method decorators. The
      // standalone Node artifact must lower them before remote execution.
      return ts.transpileModule(code, {
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, experimentalDecorators: true },
      }).outputText
    },
  }],
}])
