/**
 * Build all four extension targets sequentially.
 *
 * Outputs:
 *   build/chrome-mv3-prod/   — Chrome / Edge MV3
 *   build/chrome-mv2-prod/   — Chrome / Edge MV2 (legacy)
 *   build/firefox-mv3-prod/  — Firefox MV3
 *   build/firefox-mv2-prod/  — Firefox MV2 (legacy)
 */
const { execSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");

const targets = [
  "chrome-mv3",
  "chrome-mv2",
  "firefox-mv3",
  "firefox-mv2",
];

function run(cmd) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

// Step 1: extract lzma-wasm (idempotent).
run("node scripts/extract-lzma-wasm.cjs");

// Step 2: build each target.
for (const target of targets) {
  const outDir = `${target}-prod`;
  run(
    `plasmo build --target=${target} && ` +
      `node scripts/fix-manifest.cjs ${outDir} && ` +
      `cp node_modules/@foxglove/wasm-zstd/dist/wasm-zstd.wasm build/${outDir}/wasm-zstd.wasm`
  );
}

console.log("\n✅ All targets built:");
for (const target of targets) {
  console.log(`   build/${target}-prod/`);
}
