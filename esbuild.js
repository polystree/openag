const esbuild = require("esbuild");
const pkg = require("./package.json");

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: !isProduction,
  minify: isProduction,
  minifyWhitespace: isProduction,
  minifyIdentifiers: isProduction,
  minifySyntax: isProduction,
  drop: isProduction ? ["debugger"] : [],
  legalComments: "none",
  treeShaking: true,
  logLevel: "info",
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
};

async function run() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("[OpenAG] Watching for changes...");
  } else {
    await esbuild.build(buildOptions);
    console.log(`[OpenAG] Build complete (production=${isProduction})`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
