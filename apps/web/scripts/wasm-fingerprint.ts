import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Build-time SHA-256 of the scalar transfer-engine WASM binary. Each Vite
 * config injects it as `__WASM_TRANSFER_ENGINE_SHA256__`; the runtime loader
 * (`src/wasm/loader.ts`) verifies every fetched or inlined copy of the wasm
 * against it before instantiation.
 *
 * Threat model: this pins the artifact against runtime URL/global tampering,
 * swapped hosting, and stale build outputs. It is NOT proof against a fully
 * compromised build pipeline (the attacker regenerates this hash together
 * with the wasm) — that requires an external signing step outside this repo.
 */
export function transferEngineSha256(): string {
  const wasmPath = path.resolve(dir, "..", "wasm-pkg", "transfer_engine_bg.wasm")
  return createHash("sha256").update(readFileSync(wasmPath)).digest("hex")
}
