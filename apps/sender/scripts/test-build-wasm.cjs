const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const { isolatedWorkspace, wasmWorkspaceManifest } = require("./build-wasm.cjs")

test("the isolated WASM workspace resolves without the Python package", () => {
  const manifestPath = path.resolve(__dirname, "../../../Cargo.toml")
  const lockPath = path.resolve(__dirname, "../../../Cargo.lock")
  const manifest = fs.readFileSync(manifestPath, "utf8")
  const lock = fs.readFileSync(lockPath, "utf8")
  const temp = isolatedWorkspace()
  try {
    assert.equal(fs.existsSync(path.join(temp, "apps/python")), false)
    const metadata = JSON.parse(execFileSync("cargo", [
      "metadata", "--no-deps", "--offline", "--format-version", "1",
      "--manifest-path", path.join(temp, "Cargo.toml"),
    ], { encoding: "utf8" }))
    assert.deepEqual(metadata.packages.map((pkg) => pkg.name).sort(), [
      "qr-protocol", "raptorq-core", "transfer-engine",
    ])
    assert.equal(metadata.workspace_members.length, 3)
    assert.equal(metadata.workspace_default_members.length, 3)
    assert.equal(fs.readFileSync(manifestPath, "utf8"), manifest)
    assert.equal(fs.readFileSync(lockPath, "utf8"), lock)
    const coreManifest = fs.readFileSync(path.join(temp, "core/transfer-engine/Cargo.toml"), "utf8")
    assert.match(coreManifest, /wasm-bindgen = \{ version = "=0\.2\.92"/)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test("workspace projection retains other Cargo tables and validates its input", () => {
  const source = '[workspace]\nresolver = "2"\nmembers = ["core/transfer-engine", "apps/python"]\n\n[workspace.package]\nversion = "1.2.8"\n'
  const projected = wasmWorkspaceManifest(source)
  assert.doesNotMatch(projected, /apps\/python/)
  assert.match(projected, /default-members = \[/)
  assert.match(projected, /\[workspace.package\]\nversion = "1.2.8"/)
  assert.throws(() => wasmWorkspaceManifest('[package]\nname = "wrong"'), /workspace/)
})
