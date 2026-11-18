import { defineConfig } from 'tsup';

const shared = {
  splitting: false as const,
  sourcemap: true,
  treeshake: true,
  // ESM needs __dirname shimmed to locate data/pricing_snapshot.json.
  shims: true,
  minify: false,
};

// The source loads dependencies and optional provider SDKs with require(), which esbuild's ESM
// output turns into a shim that throws ("Dynamic require of ... is not supported") because ES
// modules have no require. Give the ESM bundles a real one, resolving from the bundle as the
// CommonJS build does.
const ESM_REQUIRE_BANNER =
  "import { createRequire as __tracciaCreateRequire } from 'module';\n" +
  'const require = __tracciaCreateRequire(import.meta.url);';

export default defineConfig([
  {
    ...shared,
    entry: [
      'src/index.ts',
      'src/auto.ts',
      'src/tracer/index.ts',
      'src/integrations/index.ts',
    ],
    format: ['cjs', 'esm'],
    banner: ({ format }) => (format === 'esm' ? { js: ESM_REQUIRE_BANNER } : {}),
    dts: true,
    clean: true,
    // Optional provider SDKs are devDependencies (for tests) but must never be
    // bundled: auto-instrumentation patches the copy the host application loads.
    external: ['openai', '@anthropic-ai/sdk'],
  },
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    dts: false,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
    external: ['openai', '@anthropic-ai/sdk'],
  },
]);
