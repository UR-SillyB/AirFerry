/**
 * Build the legacy and modern WASM variants from isolated temporary workspace
 * copies. The checked-out Cargo.toml/Cargo.lock are never rewritten, so a
 * concurrent Cargo command, interruption, or process kill cannot corrupt or
 * roll back a developer's working tree.
 */
const { execFileSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { acquireWasmLock } = require("./wasm-lock.cjs")

const senderRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(senderRoot, "../..")
const WASM_MEMBERS = ["core/raptorq-core", "core/qr-protocol", "core/transfer-engine"]

const MODERN = {
  wasmBindgen: "0.2.125",
  jsSys: "0.3.102",
  webSys: "0.3.102",
}

function run(file, args, cwd, env = process.env) {
  console.log(`\n▶ ${file} ${args.join(" ")}`)
  execFileSync(file, args, { cwd, env, stdio: "inherit" })
}

function wasmWorkspaceManifest(source) {
  const match = /^\[workspace\][^\S\r\n]*(?:\r?\n|$)/m.exec(source)
  if (!match) throw new Error("root Cargo.toml has no [workspace] section")
  const start = match.index + match[0].length
  const next = source.slice(start).search(/^\[/m)
  const end = next < 0 ? source.length : start + next
  let workspace = source.slice(start, end)
  const members = `[\n${WASM_MEMBERS.map((name) => `    "${name}",`).join("\n")}\n]`
  if (!/^members\s*=\s*\[/m.test(workspace)) {
    throw new Error("root Cargo.toml workspace has no members list")
  }
  workspace = workspace.replace(/^members\s*=\s*\[[\s\S]*?\]/m, `members = ${members}`)
  if (/^default-members\s*=\s*\[/m.test(workspace)) {
    workspace = workspace.replace(/^default-members\s*=\s*\[[\s\S]*?\]/m, `default-members = ${members}`)
  } else {
    workspace += `default-members = ${members}\n\n`
  }
  return source.slice(0, start) + workspace + source.slice(end)
}

function isolatedWorkspace() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "airferry-wasm-"))
  // This snapshot only contains core/. Host-only members (the Python/PyO3
  // package) must not be loaded or resolved by either WASM toolchain.
  const manifest = fs.readFileSync(path.join(repoRoot, "Cargo.toml"), "utf8")
  fs.writeFileSync(path.join(temp, "Cargo.toml"), wasmWorkspaceManifest(manifest))
  fs.copyFileSync(path.join(repoRoot, "Cargo.lock"), path.join(temp, "Cargo.lock"))
  fs.cpSync(path.join(repoRoot, "core"), path.join(temp, "core"), {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("target"),
  })
  return temp
}

function modernize(temp) {
  const manifest = path.join(temp, "core/transfer-engine/Cargo.toml")
  const original = fs.readFileSync(manifest, "utf8")
  const requiredPins = [
    /wasm-bindgen = \{ version = "=0\.2\.92"/,
    /^js-sys = "=0\.3\.69"/m,
    /web-sys = \{ version = "=0\.3\.69"/,
  ]
  if (requiredPins.some((pattern) => !pattern.test(original))) {
    throw new Error("one or more legacy wasm-bindgen/js-sys/web-sys pins were not found")
  }
  const modern = original
    .replace(/wasm-bindgen = \{ version = "=0\.2\.92"/, `wasm-bindgen = { version = "=${MODERN.wasmBindgen}"`)
    .replace(/^js-sys = "=0\.3\.69"/m, `js-sys = "=${MODERN.jsSys}"`)
    .replace(/web-sys = \{ version = "=0\.3\.69"/, `web-sys = { version = "=${MODERN.webSys}"`)
  fs.writeFileSync(manifest, modern)
  run("cargo", ["generate-lockfile", "--manifest-path", path.join(temp, "Cargo.toml")], temp)
}

function publishDirectory(source, name) {
  const destination = path.join(senderRoot, name)
  const staged = path.join(senderRoot, `.${name}.staged-${process.pid}`)
  fs.rmSync(staged, { recursive: true, force: true })
  fs.cpSync(source, staged, { recursive: true })
  fs.rmSync(destination, { recursive: true, force: true })
  fs.renameSync(staged, destination)
}

function buildVariant(variant) {
  const temp = isolatedWorkspace()
  try {
    if (variant === "simd") modernize(temp)
    const pkg = path.join(temp, `pkg-${variant}`)
    // `simd` is retained as the historical name of the modern wasm-bindgen
    // variant. Keep the generated module scalar so it also loads in hardened
    // or virtualized Chromium environments where WebAssembly SIMD is disabled.
    const env = process.env
    run(
      "wasm-pack",
      ["build", path.join(temp, "core/transfer-engine"), "--target", "web", "--out-dir", pkg,
        "--", "--features", "wasm,serde"],
      temp,
      env
    )
    publishDirectory(pkg, `wasm-pkg-${variant}`)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function main(requested = process.argv[2] || "all") {
  if (!new Set(["all", "legacy", "simd"]).has(requested)) {
    console.error("Usage: node scripts/build-wasm.cjs [all|legacy|simd]")
    process.exitCode = 2
    return
  }
  const releaseLock = acquireWasmLock(senderRoot)
  try {
    if (requested === "all" || requested === "legacy") buildVariant("legacy")
    if (requested === "all" || requested === "simd") buildVariant("simd")
    // Publish a default sender snapshot for direct tooling/import resolution.
    // Web copies wasm-pkg-simd into its own directory during prepare-wasm.
    if (requested !== "legacy") {
      publishDirectory(path.join(senderRoot, "wasm-pkg-simd"), "wasm-pkg")
    }
    console.log("\n✅ WASM output published without modifying Cargo sources")
  } finally {
    releaseLock()
  }
}

if (require.main === module) main()
module.exports = { isolatedWorkspace, wasmWorkspaceManifest }
