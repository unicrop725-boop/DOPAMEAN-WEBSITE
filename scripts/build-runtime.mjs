// Bundles the worker and the migration runner into single files for the production image.
import { build } from 'esbuild';

const shared = {
  platform: 'node',
  format: 'esm',
  target: 'node22',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  // Resolve the "@/..." alias; keep node_modules external so native deps stay installed normally.
  alias: { '@': './src' },
  packages: 'external',
};

await build({
  ...shared,
  entryPoints: { worker: 'src/worker/index.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
});
await build({
  ...shared,
  entryPoints: { migrate: 'scripts/migrate.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
});
