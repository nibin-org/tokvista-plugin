import esbuild from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });

const buildOptions = {
  entryPoints: ["src/code.ts"],
  bundle: true,
  outfile: "dist/code.js",
  target: ["es2017"],
  format: "iife",
  platform: "browser",
  logLevel: "info"
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  copyFileSync("src/ui.html", "dist/ui.html");
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
  copyFileSync("src/ui.html", "dist/ui.html");
}
