/**
 * WASM end-to-end smoke test (Node.js, ESM).
 *
 * Loads the actual transfer_engine WASM module (same one the browser extension
 * uses) and drives the sender: create session → next_frame → encode_qr →
 * verify. This reproduces what the extension's QrStream component does, so it
 * proves the WASM path doesn't panic on real input.
 *
 * Run: node crates/transfer-engine/scripts/wasm_e2e.mjs
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import init, { SenderSessionWasm, encode_qr } from "../pkg/transfer_engine.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(__dirname, "..", "pkg")

async function main() {
  console.log("[1] Initializing WASM module...")
  // Pass a pre-compiled module so the glue doesn't try to fetch a URL.
  const wasmBytes = readFileSync(join(pkgDir, "transfer_engine_bg.wasm"))
  const mod = await WebAssembly.compile(wasmBytes)
  await init(mod)
  console.log("    OK")

  // Build a fake file payload (~200 KB, pseudo-random but deterministic).
  const size = 200_000
  const payload = new Uint8Array(size)
  for (let i = 0; i < size; i++) payload[i] = (i * 2654435761) & 0xff

  console.log(`[2] Creating sender session (${size} bytes)...`)
  const sidLo = 0x1122334455667788n
  const sidHi = 0x99aabbccddeeff00n
  const session = new SenderSessionWasm(payload, sidLo, sidHi, 20, 1024, "test.bin", BigInt(size), 0x12345678)
  console.log(
    `    OK — total_symbols=${session.total_symbols()} blocks=${session.num_blocks()}`
  )

  console.log("[3] Emitting 50 frames + encoding each to QR...")
  let lastSide = 0
  for (let i = 0; i < 50; i++) {
    const frame = session.next_frame()
    if (!(frame instanceof Uint8Array)) {
      throw new Error(`next_frame returned non-Uint8Array at i=${i}`)
    }
    const sideBuf = new Uint32Array(1)
    const matrix = encode_qr(frame, sideBuf)
    if (!(matrix instanceof Uint8Array) || matrix.length !== sideBuf[0] * sideBuf[0]) {
      throw new Error(
        `encode_qr bad output: len=${matrix?.length} side=${sideBuf[0]}`
      )
    }
    lastSide = sideBuf[0]
  }
  console.log(`    OK — 50 frames encoded. Last QR: ${lastSide}x${lastSide} modules`)

  console.log("[4] Verifying frame 0 carries the right session id + magic...")
  const s2 = new SenderSessionWasm(payload, sidLo, sidHi, 20, 1024, "test.bin", BigInt(size), 0x12345678)
  const f0 = s2.next_frame()
  const dv = new DataView(f0.buffer, f0.byteOffset, f0.byteLength)
  const magic = dv.getUint16(0)
  if (magic !== 0x4554) throw new Error(`bad magic 0x${magic.toString(16)}`)
  // Header layout (big-endian): magic(2) ver(1) flags(1) session_id(16).
  // session_id = hi(8) || lo(8) in the wire layout (u128 big-endian).
  const wireHi = dv.getBigUint64(4)
  const wireLo = dv.getBigUint64(12)
  if (wireHi !== sidHi || wireLo !== sidLo) {
    throw new Error(
      `session id mismatch: got wireHi=${wireHi} wireLo=${wireLo}`
    )
  }
  console.log(`    OK — magic=0x${magic.toString(16)} session id matches`)

  console.log("[5] Stats JSON parseable...")
  const stats = JSON.parse(session.stats_json())
  console.log(
    `    OK — frames=${stats.frames} bytes=${stats.bytes} fps=${stats.fps.toFixed(1)}`
  )

  console.log("\n✅ WASM end-to-end smoke test PASSED")
  console.log("   The WASM sender + QR encoder run without panics.")
}

main().catch((e) => {
  console.error("\n❌ FAILED:", e)
  process.exit(1)
})
