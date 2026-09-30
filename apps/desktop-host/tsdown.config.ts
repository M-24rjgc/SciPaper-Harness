import { defineConfig } from 'tsdown'

export default defineConfig(['index', 'cli', 'office-cli'].map(entry => ({
  entry: [`lib/types/${entry}.js`],
  outDir: 'lib',
  format: ['esm'] as const,
  outputOptions: { codeSplitting: false },
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})))
