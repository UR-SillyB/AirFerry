#!/usr/bin/env node
/**
 * Release artifact verification gate.
 *
 * Verifies all published artifacts match project invariants:
 *   - version across all files matches Cargo.toml (delegates to version.mjs)
 *   - release upload list does NOT contain private keys (*.pem, *.keystore)
 *   - required web/extension artifacts are actually present in dist/
 *   - extension manifests carry the current version
 *   - receiver build contains the FAST ZXing JS/WASM payload
 *   - standalone sender HTML is built and self-contained
 *   - signed CRX/APK artifacts are required whenever their signing/build
 *     inputs are present (or AIRFERRY_REQUIRE_SIGNED_RELEASE=1)
 *
 * Any failure exits non-zero. This gate must never swallow errors: a failed
 * sub-check is a failed gate, not a "skipped safely".
 *
 * Usage:
 *   node scripts/verify-dist.mjs
 */
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(path.join(root, "apps/web/package.json"), "utf8"))
const version = pkg.version

function requireFile(filePath, label, minBytes = 1) {
  if (!existsSync(filePath)) {
    console.error(`✗ ${label} missing: ${filePath}`)
    process.exit(1)
  }
  const size = statSync(filePath).size
  if (size < minBytes) {
    console.error(`✗ ${label} is unexpectedly small (${size} bytes): ${filePath}`)
    process.exit(1)
  }
  return filePath
}

function hasBash() {
  if (process.platform !== "win32") return true
  try {
    execFileSync("bash", ["--version"], { cwd: root, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function runBuildAll(target, options = {}) {
  const isWin = process.platform === "win32"
  const bin = isWin ? "bash" : "./scripts/build-all.sh"
  const args = isWin ? ["./scripts/build-all.sh", target] : [target]
  return execFileSync(bin, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  })
}

console.log("▶ 1. Version gate check")
// Delegate to the real gate (root Cargo.toml [workspace.package].version is
// the single source of truth; version.mjs checks all 6 declared sites).
try {
  execFileSync(process.execPath, ["scripts/version.mjs", "check"], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  })
} catch {
  console.error("✗ version gate failed (see output above)")
  process.exit(1)
}

console.log("▶ 2. Security gate check (release upload set)")
// Mirror build-all.sh's release_upload_list filter in Node so this safety gate
// is also runnable on Windows hosts that do not have Git Bash installed.
const distDir = path.join(root, "dist")
const releaseName = new RegExp(`^airferry-.*-v${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(?:apk|zip|crx|xpi|html)$`)
const uploadFiles = existsSync(distDir)
  ? readdirSync(distDir).filter((name) => releaseName.test(name)).sort()
  : []
// dist/ intentionally also stores local signing inputs. The security
// invariant is that the *release upload set* excludes them, not that dist/
// contains no keys at all. Permit only the two fixed, documented local inputs;
// any other PEM/keystore in dist is suspicious and fails closed.
const allowedLocalSigningInputs = new Set([
  "airferry-extension.pem",
  "airferry-release.keystore",
])
const unexpectedSecretFiles = existsSync(distDir)
  ? readdirSync(distDir).filter(
      (name) =>
        (name.endsWith(".pem") || name.endsWith(".keystore")) &&
        !allowedLocalSigningInputs.has(name)
    )
  : []
if (unexpectedSecretFiles.length > 0) {
  console.error(`✗ CRITICAL: unexpected secret/key file(s) in dist/: ${unexpectedSecretFiles.join(", ")}`)
  process.exit(1)
}
const secretUploadHits = uploadFiles.filter(
  (name) => name.endsWith(".pem") || name.endsWith(".keystore")
)
if (secretUploadHits.length > 0) {
  console.error(`✗ CRITICAL: secret/key file(s) in release upload set: ${secretUploadHits.join(", ")}`)
  process.exit(1)
}
console.log("   release upload list is safe (local signing keys excluded)")

console.log("▶ 3. Package current build to dist/")
// verify-dist is intentionally self-sufficient: CI historically invoked this
// gate before a separate `build-all.sh dist`, which meant it could not verify
// the files that would actually be uploaded. Pack first, then inspect exactly
// that artifact set. The later CI packaging step is harmless/idempotent.
if (hasBash()) {
  try {
    const out = runBuildAll("dist", { stdio: ["ignore", "pipe", "pipe"] })
    if (out.trim()) console.log(out.trim())
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || e).toString()
    console.error(`✗ packaging dist failed:\n${detail}`)
    process.exit(1)
  }
} else {
  console.log("   Git Bash not available on Windows; verifying the existing dist/ artifact set")
}

console.log("▶ 4. Packaged artifact completeness check")
const dist = path.join(root, "dist")
const requiredDist = [
  [`airferry-sender-chrome-mv3-v${version}.zip`, "Chrome MV3 zip"],
  [`airferry-sender-chrome-mv2-v${version}.zip`, "Chrome MV2 zip"],
  [`airferry-sender-firefox-mv3-v${version}.xpi`, "Firefox MV3 xpi"],
  [`airferry-sender-firefox-mv2-v${version}.xpi`, "Firefox MV2 xpi"],
  [`airferry-sender-web-v${version}.zip`, "Web sender zip"],
  [`airferry-receiver-web-v${version}.zip`, "Web receiver zip"],
  [`airferry-sender-web-standalone-v${version}.html`, "Standalone sender HTML"],
]
for (const [name, label] of requiredDist) {
  requireFile(path.join(dist, name), label, 64)
}

const signingKey = path.join(dist, "airferry-extension.pem")
const requireSigned = process.env.AIRFERRY_REQUIRE_SIGNED_RELEASE === "1" || existsSync(signingKey)
if (requireSigned) {
  requireFile(path.join(dist, `airferry-sender-chrome-mv3-v${version}.crx`), "signed Chrome MV3 CRX", 64)
  requireFile(path.join(dist, `airferry-sender-chrome-mv2-v${version}.crx`), "signed Chrome MV2 CRX", 64)
}

const releaseApk = path.join(root, "apps/scanner/app/build/outputs/apk/release/app-release.apk")
if (existsSync(releaseApk)) {
  requireFile(path.join(dist, `airferry-receiver-android-arm64-v${version}.apk`), "release Android APK", 1024)
}
console.log("   packaged artifact set is complete")

console.log("▶ 5. Extension manifest check")
for (const target of ["chrome-mv3-prod", "chrome-mv2-prod", "firefox-mv3-prod", "firefox-mv2-prod"]) {
  const manifestPath = path.join(root, "apps/web/build", target, "manifest.json")
  requireFile(manifestPath, `${target} manifest`, 16)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (manifest.version !== version) {
    console.error(`✗ ${target} manifest version mismatch: ${manifest.version} != ${version}`)
    process.exit(1)
  }
}
console.log("   extension manifests match current version")

/**
 * Entry names of a classic (non-ZIP64) zip file — enough to assert that an
 * uploaded artifact actually contains its required payload files without
 * depending on an unzip binary. Throws on malformed input.
 */
function listZipEntries(file) {
  const buf = readFileSync(file)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`no end-of-central-directory record in ${file}`)
  const count = buf.readUInt16LE(eocd + 10)
  if (count === 0xffff) throw new Error(`ZIP64 central directory not supported by checker: ${file}`)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`bad central-directory header at ${offset} in ${file}`)
    }
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    entries.push(buf.toString("utf8", offset + 46, offset + 46 + nameLen))
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

console.log("▶ 6. FAST ZXing receiver payload check")
// Build-tree check (what Vite just produced)…
const fastJs = requireFile(path.join(root, "apps/web/dist-receiver/airferry_zxing.js"), "FAST ZXing JS", 1024)
requireFile(path.join(root, "apps/web/dist-receiver/airferry_zxing.wasm"), "FAST ZXing WASM", 64 * 1024)
if (!readFileSync(fastJs, "utf8").includes("_airferry_wasm_decode_multi_y")) {
  console.error("✗ FAST ZXing JS does not expose the expected decoder entrypoint")
  process.exit(1)
}
// …and the artifact actually uploaded: the receiver zip must carry the
// payload inside it (a size check alone would false-pass on a divergent pack).
try {
  const zipEntries = listZipEntries(path.join(dist, `airferry-receiver-web-v${version}.zip`))
  for (const needed of ["airferry_zxing.js", "airferry_zxing.wasm"]) {
    if (!zipEntries.some((n) => n === needed || n.endsWith(`/${needed}`))) {
      console.error(`✗ receiver-web zip does not contain ${needed}`)
      process.exit(1)
    }
  }
} catch (e) {
  console.error(`✗ receiver-web zip is unreadable: ${e.message}`)
  process.exit(1)
}
console.log("   FAST ZXing payload is present (build tree + uploaded artifact)")

console.log("▶ 7. Standalone HTML check")
const standaloneHtml = path.join(root, "apps/web/dist-standalone/index.html")
requireFile(standaloneHtml, "standalone HTML", 1024)
const html = readFileSync(standaloneHtml, "utf8")
// Also verify the artifact that is actually uploaded, not just the build tree.
const standaloneArtifact = readFileSync(
  requireFile(path.join(dist, `airferry-sender-web-standalone-v${version}.html`), "standalone artifact HTML", 1024),
  "utf8"
)
// Two independent conditions: the payload is present ("AirFerry"), and the
// page is self-contained (no external <script src=...> — everything inline).
// Note: `__AIRFERRY_STANDALONE__` legitimately survives as a runtime global
// flag (`globalThis.__AIRFERRY_STANDALONE__ = true`), so its presence is NOT
// a substitution failure.
for (const [label, doc] of [
  ["build tree", html],
  ["uploaded artifact", standaloneArtifact],
]) {
  if (!doc.includes("AirFerry") || doc.includes("<script src=")) {
    console.error(`✗ standalone HTML (${label}) invalid (payload missing or not self-contained)`)
    process.exit(1)
  }
}
console.log("   standalone HTML ok (build tree + uploaded artifact)")

console.log("✅ All dist verification checks passed.")
