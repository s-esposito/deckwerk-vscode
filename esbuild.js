// Build script for the DeckWerk VS Code extension. One package, two targets:
//   out/extension.js – extension host (Node, CommonJS; `vscode` is external)
//   out/bridge.mjs   – the socket bridge run inside the server's network namespace,
//                      under DeckWerk's own Node (>= 22), not the extension host's
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const bridgeConfig = {
  entryPoints: ["src/bridge.ts"],
  bundle: true,
  outfile: "out/bridge.mjs",
  platform: "node",
  format: "esm",
  target: "node22",
};

async function run() {
  if (watch) {
    const ctxs = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(bridgeConfig),
    ]);
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("[deckwerk] watching extension + bridge for changes…");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(bridgeConfig),
    ]);
    console.log("[deckwerk] built extension + bridge");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
