/**
 * Build all four extension targets sequentially.
 *
 * Outputs:
 *   build/chrome-mv3-prod/   — Chrome / Edge MV3  (uses wasm-pkg-simd)
 *   build/chrome-mv2-prod/   — Chrome / Edge MV2  (uses wasm-pkg-legacy)
 *   build/firefox-mv3-prod/  — Firefox MV3        (uses wasm-pkg-simd)
 *   build/firefox-mv2-prod/  — Firefox MV2        (uses wasm-pkg-legacy)
 *
 * ## Per-target WASM selection
 *
 * The two WASM variants are pre-built by scripts/build-wasm.cjs into
 * wasm-pkg-legacy/ (MV2, Chrome87-safe, no SIMD) and wasm-pkg-simd/ (MV3,
 * wasm-bindgen 0.2.125 + SIMD). The loader (src/wasm/loader.ts) imports from a
 * fixed path `../../wasm-pkg/`, so before each `plasmo build` we copy the
 * appropriate variant into `wasm-pkg/`. This keeps the loader path static
 * (Vite/Plasmo bundling is unchanged) while still shipping per-target wasm.
 */
const { execSync } = require("child_process");
const fs = require("fs");
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

/**
 * Copy wasm-pkg-<variant>/ over wasm-pkg/ so the next plasmo build bundles
 * the right WASM module. `variant` is "simd" for MV3 targets, "legacy" for
 * MV2. We wipe and re-copy rather than symlink so Plasmo/Vite's file-watching
 * sees a real directory (some bundlers mis-handle symlinks in the build).
 */
function useWasmPkg(variant) {
  const src = path.resolve(root, `wasm-pkg-${variant}`);
  const dst = path.resolve(root, "wasm-pkg");
  if (!fs.existsSync(src)) {
    console.error(
      `\n✖ wasm-pkg-${variant}/ missing. Run \`npm run wasm\` (scripts/build-wasm.cjs) first.`
    );
    process.exit(1);
  }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log(`   (wasm: ${variant})`);
}

// Build each target. MV3 → SIMD variant; MV2 → legacy (Chrome87-safe) variant.
for (const target of targets) {
  const isMV3 = target.endsWith("mv3");
  useWasmPkg(isMV3 ? "simd" : "legacy");
  const outDir = `${target}-prod`;
  run(
    `plasmo build --target=${target} && ` +
      `node scripts/fix-manifest.cjs ${outDir} && ` +
      `cp node_modules/@foxglove/wasm-zstd/dist/wasm-zstd.wasm build/${outDir}/wasm-zstd.wasm`
  );
}

console.log("\n✅ All targets built:");
for (const target of targets) {
  const variant = target.endsWith("mv3") ? "simd" : "legacy";
  console.log(`   build/${target}-prod/  (wasm: ${variant})`);
}
