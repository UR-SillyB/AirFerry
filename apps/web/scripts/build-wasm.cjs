/**
 * Build the single scalar WASM package (wasm-bindgen =0.2.92, no SIMD, no
 * externref) from an isolated temporary workspace copy. The checked-out
 * Cargo.toml/Cargo.lock are never rewritten, so a concurrent Cargo command,
 * interruption, or process kill cannot corrupt a developer's working tree.
 *
 * Output: wasm-pkg/ — the ONE long-lived product consumed by
 *   - the extension builds (scripts/build-ext.cjs, via the @airferry-wasm alias)
 *   - the web app (apps/web/scripts/prepare-wasm.cjs copies it into a private
 *     apps/web/wasm-pkg/ snapshot)
 *
 * The former dual-track (wasm-pkg-legacy + wasm-pkg-simd with an upgraded
 * wasm-bindgen 0.2.125 / +simd128 / externref variant for MV3) was removed:
 * measured, SIMD/externref gave no speedup on the scalar raptorq/fast_qr hot
 * path while doubling the build matrix and the compatibility surface. The
 * single 0.2.92 scalar artifact loads everywhere from Chrome 87 to current.
 * FAST ZXing (-msimd128) lives in the web RECEIVER bundle only and is built
 * separately by scripts/build-fastzxing.sh.
 */
const { execFileSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { acquireWasmLock } = require("./wasm-lock.cjs")

const senderRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(senderRoot, "../..")

function run(file, args, cwd, env = process.env) {
  console.log(`\n▶ ${file} ${args.join(" ")}`)
  execFileSync(file, args, { cwd, env, stdio: "inherit" })
}

function isolatedWorkspace() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "airferry-wasm-"))
  fs.copyFileSync(path.join(repoRoot, "Cargo.toml"), path.join(temp, "Cargo.toml"))
  fs.copyFileSync(path.join(repoRoot, "Cargo.lock"), path.join(temp, "Cargo.lock"))
  fs.cpSync(path.join(repoRoot, "core"), path.join(temp, "core"), {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("target"),
  })
  return temp
}

function publishDirectory(source, name) {
  const destination = path.join(senderRoot, name)
  // Stage beside the destination, then swap in one atomic rename. Plain
  // `rename` onto a non-empty directory fails on POSIX, so the old directory
  // is removed first — both under the build lock, so no reader ever sees a
  // half-published package.
  const staged = path.join(senderRoot, `.${name}.staged-${process.pid}`)
  fs.rmSync(staged, { recursive: true, force: true })
  fs.cpSync(source, staged, { recursive: true })
  // Keep the product git-ignored no matter what the surrounding ignore files do.
  fs.writeFileSync(path.join(staged, ".gitignore"), "*\n")
  fs.rmSync(destination, { recursive: true, force: true })
  fs.renameSync(staged, destination)
}

const temp = isolatedWorkspace()
const releaseLock = acquireWasmLock(senderRoot)
// Persistent target dir (git-ignored via the root `target/` rule): the source
// copy is per-run isolated, but registry dependencies (the bulk of the wasm
// build) are fingerprinted by content hash and reuse this cache, turning every
// rerun from a full cold build into an incremental one.
const targetDir = path.join(repoRoot, "target", "wasm-pack")
try {
  const pkg = path.join(temp, "pkg")
  run(
    "wasm-pack",
    [
      "build",
      path.join(temp, "core/transfer-engine"),
      "--target",
      "web",
      // Absolute path: wasm-pack resolves a relative --out-dir against the
      // crate manifest directory, not the process cwd.
      "--out-dir",
      pkg,
      "--",
      "--features",
      "wasm",
    ],
    temp,
    { ...process.env, CARGO_TARGET_DIR: targetDir }
  )
  publishDirectory(pkg, "wasm-pkg")
  console.log("\n✅ WASM output published without modifying Cargo sources")
} finally {
  releaseLock()
  fs.rmSync(temp, { recursive: true, force: true })
}
