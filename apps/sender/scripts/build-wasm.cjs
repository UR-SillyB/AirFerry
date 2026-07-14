/**
 * Build BOTH WASM variants the sender ships:
 *
 *   ① wasm-pkg-legacy/ — wasm-bindgen 0.2.92 (the default pinned in
 *      core/transfer-engine/Cargo.toml), scalar (no SIMD), no reference-types
 *      / externref. Loadable on Chrome 87+ (the MV3 extension_pages baseline)
 *      and Firefox 91+. Used by the MV2 build targets.
 *
 *   ② wasm-pkg-simd/ — wasm-bindgen 0.2.125 + js-sys/web-sys 0.3.102 (a modern,
 *      reference-types-enabled combo), built with RUSTFLAGS=+simd128. Used by
 *      the MV3 build targets. The `next_qr_into` zero-copy API is available in
 *      both variants.
 *
 * ## ⚠️ Measured performance (do NOT expect a speedup)
 *
 * Benchmark on the full `next_qr_into` path (V25 / 1400B symbol, 5000 frames),
 * taken BEFORE the QR library swap (i.e. with the old scalar `qrcode` crate):
 *   - SIMD vs scalar: 0.95× (slightly SLOWER). `raptorq` and `qrcode` were pure
 *     scalar Rust with no `std::arch::wasm32::*` intrinsics, so `+simd128` had
 *     nothing to vectorize — it only made the wasm ~8KB larger (312KB vs
 *     304KB) and marginally slower from icache pressure.
 *   - externref: no measurable win either; the cost was drowned out by QR
 *     Reed-Solomon encoding (~4.8ms/frame, ~98% of per-tick work).
 *
 * NOTE: QR encoding now uses `fast_qr` (replaces `qrcode`, ~7-9× faster on the
 * Reed-Solomon path), so QR is no longer the dominant cost. The SIMD finding
 * still holds: `fast_qr` likewise has no wasm32 SIMD intrinsics, so `+simd128`
 * remains a no-op for the hot path. Re-benchmark if a SIMD-aware QR lib is added.
 *
 * ## Why keep the dual build + SIMD then
 *
 *   1. Solves the root cause of the Chrome 87 `externref` CompileError: MV2
 *      gets the legacy (externref-free) build, MV3 gets the modern one.
 *   2. Keeps the build infrastructure ready for the day we swap in a SIMD-aware
 *      RaptorQ GF(256) SIMD path — flipping `+simd128` on/off is then a
 *      one-line change with instant effect.
 *
 * ## How the dual-version build stays reproducible
 *
 * The default checked-in Cargo.toml pins wasm-bindgen = "=0.2.92" (and
 * js-sys / web-sys = "=0.3.69") with exact `=` requirements — this MUST stay
 * the default state so any casual `cargo update` / `cargo test` produces a
 * Chrome-87-safe module. To build the SIMD variant against a newer
 * wasm-bindgen we temporarily rewrite those three version pins to a modern
 * matched set, regenerate Cargo.lock, run wasm-pack, then RESTORE the
 * original bytes verbatim in `finally`. This preserves even uncommitted
 * Cargo.toml/Cargo.lock edits that existed before the build; the script never
 * uses `git checkout` to overwrite developer work.
 *
 * Output dirs (both git-ignored via their internal `*` .gitignore copied from
 * wasm-pack's pkg/ output):
 *   apps/sender/wasm-pkg-legacy/   ← MV2 targets
 *   apps/sender/wasm-pkg-simd/     ← MV3 targets
 * The loader (apps/sender/src/wasm/loader.ts) still imports from `wasm-pkg/`;
 * scripts/build-all.cjs copies the right variant into `wasm-pkg/` per target
 * before each `plasmo build`.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const repoRoot = path.resolve(root, "../..");
const cargoTomlPath = path.join(repoRoot, "core/transfer-engine/Cargo.toml");
const cargoLockPath = path.join(repoRoot, "Cargo.lock");

// Modern, matched triple: these three crates release in lockstep, so their
// versions must move together. 0.2.125 / 0.3.102 is the current stable line.
const MODERN = {
  wasmBindgen: "0.2.125",
  jsSys: "0.3.102",
  webSys: "0.3.102",
};

function run(cmd, opts = {}) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit", ...opts });
}

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

// --- 1. Read the canonical Cargo.toml and verify it's in the expected
//        legacy-pinned state before we touch anything. ----------------------
const originalToml = fs.readFileSync(cargoTomlPath, "utf8");
const originalLock = fs.readFileSync(cargoLockPath);

const LEGACY_PATTERNS = {
  wasmBindgen: /wasm-bindgen = \{ version = "=0\.2\.92"/,
  jsSys: /^js-sys = "=0\.3\.69"/m,
  webSys: /web-sys = \{ version = "=0\.3\.69"/,
};
for (const [k, re] of Object.entries(LEGACY_PATTERNS)) {
  if (!re.test(originalToml)) {
    fail(
      `Cargo.toml is not in the expected legacy-pinned state (${k} does not match ${re}). ` +
        `Refusing to rewrite — restore core/transfer-engine/Cargo.toml to wasm-bindgen =0.2.92 / js-sys,web-sys =0.3.69 before retrying.`
    );
  }
}

try {
  // --- 2. Legacy build (uses the default =0.2.92 pins as-is). --------------
  console.log("\n=== [1/2] Legacy WASM (wasm-bindgen 0.2.92, scalar, Chrome87-safe) ===");
  run("npm run wasm:legacy");

  // --- 3. SIMD build: temporarily rewrite Cargo.toml + Cargo.lock. --------
  console.log("\n=== [2/2] SIMD WASM (wasm-bindgen 0.2.125 + SIMD, MV3) ===");
  const modernized = originalToml
    .replace(
      /wasm-bindgen = \{ version = "=0\.2\.92"/,
      `wasm-bindgen = { version = "=${MODERN.wasmBindgen}"`
    )
    .replace(/^js-sys = "=0\.3\.69"/m, `js-sys = "=${MODERN.jsSys}"`)
    .replace(
      /web-sys = \{ version = "=0\.3\.69"/,
      `web-sys = { version = "=${MODERN.webSys}"`
    );
  fs.writeFileSync(cargoTomlPath, modernized);
  console.log(
    `  Cargo.toml rewritten: wasm-bindgen =${MODERN.wasmBindgen}, js-sys/web-sys =${MODERN.jsSys}`
  );

  // Re-resolve the lockfile so wasm-pack downloads the matching cli. Run from
  // the repo root so the workspace Cargo.lock is what gets regenerated.
  run("cargo generate-lockfile", { cwd: repoRoot });
  run("npm run wasm:simd");
} finally {
  // --- 4. Restore both files from their pre-build byte snapshots. --------
  //    This is the critical reproducibility invariant: after this script,
  //    `git status` must show no Cargo.toml / Cargo.lock changes.
  //
  //    Never restore through Git: doing so discards legitimate uncommitted
  //    lockfile changes that predated this build. We also must not run
  //    `cargo generate-lockfile` here because it would re-resolve unrelated
  //    packages. The startup snapshots preserve the caller's exact bytes.
  try {
    fs.writeFileSync(cargoTomlPath, originalToml);
    fs.writeFileSync(cargoLockPath, originalLock);
    console.log("\n✓ Cargo.toml + Cargo.lock restored to their pre-build bytes.");
  } catch (restoreErr) {
    console.error("\n‼ Failed to restore the pre-build Cargo file snapshots.");
    console.error(`   Cargo.toml: ${cargoTomlPath}`);
    console.error(`   Cargo.lock: ${cargoLockPath}`);
    throw restoreErr;
  }
}

console.log("\n✅ Both WASM variants built:");
console.log("   apps/sender/wasm-pkg-legacy/  (MV2 targets, Chrome87-safe)");
console.log("   apps/sender/wasm-pkg-simd/    (MV3 targets, SIMD)");
