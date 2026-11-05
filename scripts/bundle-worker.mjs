// Compile the worker (and its start-up script) into one JS file at image build time, so the
// container does not convert TypeScript at runtime (saves ~100 MB of memory under the 512 MB limit).
// Workspace packages (@opengtm/*) are bundled; npm packages stay external and load from node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["apps/worker/src/start.ts", "apps/worker/src/cli.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  outExtension: { ".js": ".mjs" },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [
    {
      name: "external-npm",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith("@opengtm/") ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});
console.log("bundled dist/start.mjs and dist/cli.mjs");
