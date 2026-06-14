/**
 * Dump WASM-produced frames to a binary file for cross-language verification.
 *
 * Produces `frames.bin` = [u32 frame_count][ for each: u32 len, bytes ].
 * The Rust test (tests/wasm_interop.rs) reads this file, feeds frames to the
 * native ReceiverSession, and verifies recovery against the same payload.
 *
 * Run: node crates/transfer-engine/scripts/wasm_dump_frames.mjs <size>
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import init, { SenderSessionWasm } from "../pkg/transfer_engine.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(__dirname, "..", "pkg")
const outFile = join(__dirname, "frames.bin")
const payloadFile = join(__dirname, "payload.bin")

const size = Number(process.argv[2] ?? "200000")
// How many frames to emit: enough source symbols + redundancy + a descriptor
// pass. Use ~3× the source-symbol count to guarantee recovery even with some
// descriptors interspersed.

async function main() {
  const wasmBytes = readFileSync(join(pkgDir, "transfer_engine_bg.wasm"))
  await init(await WebAssembly.compile(wasmBytes))

  // Deterministic payload — same formula the Rust test uses.
  const payload = new Uint8Array(size)
  for (let i = 0; i < size; i++) payload[i] = (i * 2654435761) & 0xff
  writeFileSync(payloadFile, payload)

  const sidLo = 0x1122334455667788n
  const sidHi = 0x99aabbccddeeff00n
  const session = new SenderSessionWasm(payload, sidLo, sidHi, 30, 1024, "dump.bin", BigInt(size), 0xDEADBEEF)
  const totalK = session.total_symbols()
  const frameCount = totalK * 2 + 40

  const frames = []
  for (let i = 0; i < frameCount; i++) {
    frames.push(session.next_frame())
  }

  // Serialize: u32 count, then [u32 len, bytes]*.
  const parts = []
  const hdr = new Uint8Array(4)
  new DataView(hdr.buffer).setUint32(0, frames.length)
  parts.push(hdr)
  for (const f of frames) {
    const lb = new Uint8Array(4)
    new DataView(lb.buffer).setUint32(0, f.length)
    parts.push(lb, f)
  }
  const blob = Buffer.concat(parts.map((p) => Buffer.from(p)))
  writeFileSync(outFile, blob)

  console.log(
    `dumped ${frames.length} frames (${blob.length} bytes) for payload ${size}B (K=${totalK})`
  )
  console.log(`payload → ${payloadFile}`)
  console.log(`frames  → ${outFile}`)
}

main().catch((e) => {
  console.error("FAILED:", e)
  process.exit(1)
})
