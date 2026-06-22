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
 * Benchmark on the full `next_qr_into` path (V25 / 1400B symbol, 5000 frames):
 *   - SIMD vs scalar: 0.95× (slightly SLOWER). `raptorq` and `qrcode` are pure
 *     scalar Rust with no `std::arch::wasm32::*` intrinsics, so `+simd128` has
 *     nothing to vectorize — it only makes the wasm ~8KB larger (312KB vs
 *     304KB) and marginally slower from icache pressure.
 *   - externref: no measurable win either; the cost is drowned out by QR
 *     Reed-Solomon encoding (~4.8ms/frame, ~98% of per-tick work).
 *
 * ## Why keep the dual build + SIMD then
 *
 *   1. Solves the root cause of the Chrome 87 `externref` CompileError: MV2
 *      gets the legacy (externref-free) build, MV3 gets the modern one.
 *   2. Keeps the build infrastructure ready for the day we swap in a SIMD-aware
 *      QR library or RaptorQ GF(256) SIMD — flipping `+simd128` on/off is then
 *      a one-line change with instant effect.
 *
 * ## How the dual-version build stays reproducible
 *
 * The default checked-in Cargo.toml pins wasm-bindgen = "=0.2.92" (and
 * js-sys / web-sys = "=0.3.69") with exact `=` requirements — this MUST stay
 * the default state so any casual `cargo update` / `cargo test` produces a
 * Chrome-87-safe module. To build the SIMD variant against a newer
 * wasm-bindgen we temporarily rewrite those three version pins to a modern
 * matched set, regenerate Cargo.lock, run wasm-pack, then RESTORE the
 * original bytes verbatim in `finally`. `git status` after this script is
 * therefore always clean (modulo the generated wasm-pkg-* dirs which are
 * git-ignored). A `git checkout Cargo.toml Cargo.lock` is the belt-and-
 * suspenders fallback if the restore somehow fails.
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
  // --- 4. Restore Cargo.toml verbatim + Cargo.lock via git checkout. -----
  //    This is the critical reproducibility invariant: after this script,
  //    `git status` must show no Cargo.toml / Cargo.lock changes.
  //
  //    Cargo.toml we restore from the in-memory `originalToml` snapshot (no git
  //    round-trip needed). Cargo.lock we restore via `git checkout`: we MUST
  //    NOT use `cargo generate-lockfile` here, because that would re-resolve
  //    the WHOLE dependency tree and bump unrelated packages (bytes, cc, syn,
  //    …) to their latest compatible versions, leaking unrelated changes into
  //    the lockfile. `git checkout Cargo.lock` restores it byte-exact.
  try {
    fs.writeFileSync(cargoTomlPath, originalToml);
    execSync("git checkout Cargo.lock", {
      cwd: repoRoot,
      stdio: "inherit",
    });
    console.log("\n✓ Cargo.toml + Cargo.lock restored to legacy =0.2.92 state.");
  } catch (restoreErr) {
    // Last line of defense: restore Cargo.toml from git too.
    console.error(
      "\n✖ Restore failed — falling back to `git checkout Cargo.toml Cargo.lock`"
    );
    try {
      execSync("git checkout Cargo.toml Cargo.lock", {
        cwd: repoRoot,
        stdio: "inherit",
      });
      console.log("\n✓ Cargo.toml + Cargo.lock restored via git fallback.");
    } catch (gitErr) {
      console.error(
        "\n‼ git checkout also failed. RUN THIS MANUALLY before committing:"
      );
      console.error(`    cd ${repoRoot} && git checkout Cargo.toml Cargo.lock`);
      throw gitErr;
    }
  }
}

console.log("\n✅ Both WASM variants built:");
console.log("   apps/sender/wasm-pkg-legacy/  (MV2 targets, Chrome87-safe)");
console.log("   apps/sender/wasm-pkg-simd/    (MV3 targets, SIMD)");
