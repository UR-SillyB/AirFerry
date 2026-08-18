// AF2 cross-platform golden-vector assertions (web side).
//
// Mirrors apps/scanner Af2GoldenVectorTest.kt and apps/windows
// Af2GoldenVectorTests.cs: all platforms assert the SAME fixture at
// core/testdata/af2/manifest.json, so a wire-format change that any platform
// misses shows up as a fixture disagreement instead of silent drift.
//
// Depth is intentionally header-level here (matching Kotlin/C#): the full
// record/ID round-trip lives in core/af2/tests/golden_vectors.rs — Rust is
// the single protocol authority, hosts only route frames.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fixturePath = path.join(webRoot, "..", "..", "core", "testdata", "af2", "manifest.json")

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"))

function unhex(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

const MAGIC = 0x4146 // "AF"
const WIRE_VERSION = 2
// Frame types (flags byte): ROOT=1, OBJECT_META=2, SYMBOL=3.
const FRAME_TYPE_ROOT = 1
const FRAME_TYPE_META = 2
const FRAME_TYPE_SYMBOL = 3

/** Parse the 26-byte AF2 frame header (big-endian layout per docs/SPEC.md §5). */
function parseHeader(bytes) {
  assert.ok(bytes.length >= 26, "frame shorter than the 26-byte header")
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    magic: dv.getUint16(0, false),
    version: bytes[2],
    frameType: bytes[3],
    objectIdHex: toHex(bytes.subarray(4, 20)),
    bodyLen: dv.getUint16(20, false),
    sbn: bytes[22],
    // esi is a 24-bit BE field at bytes 23..25
    esi: (bytes[23] << 16) | (bytes[24] << 8) | bytes[25],
  }
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

test("fixture carries the shared AF2 wire constants", () => {
  assert.equal(fixture.protocol, "af2")
  assert.equal(fixture.schema, 1)
  // BLAKE3 empty-input digest — the cross-platform hash-domain self-check.
  assert.equal(
    fixture.blake3_empty_hash,
    "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
  )
})

test("three-layer IDs have the documented widths", () => {
  const { three_ids: ids } = fixture
  assert.equal(ids.content_id_hex.length, 64) // 256-bit
  assert.equal(ids.transfer_id_hex.length, 32) // 128-bit
  assert.equal(ids.object_id_hex.length, 32) // 128-bit
  // ROOT frame carries the Transfer ID in the object-id slot until Object
  // META binds the Object ID (docs/SPEC.md §5).
  const root = parseHeader(unhex(fixture.root_frame_hex))
  assert.equal(root.objectIdHex, ids.transfer_id_hex)
})

test("ROOT / OBJECT_META / SYMBOL frames parse against the golden bytes", () => {
  const root = parseHeader(unhex(fixture.root_frame_hex))
  assert.equal(root.magic, MAGIC)
  assert.equal(root.version, WIRE_VERSION)
  assert.equal(root.frameType, FRAME_TYPE_ROOT)

  const meta = parseHeader(unhex(fixture.object_meta_frame_hex))
  assert.equal(meta.magic, MAGIC)
  assert.equal(meta.version, WIRE_VERSION)
  assert.equal(meta.frameType, FRAME_TYPE_META)
  assert.equal(meta.objectIdHex, fixture.three_ids.object_id_hex)

  const symbol = parseHeader(unhex(fixture.symbol_frame_hex))
  assert.equal(symbol.magic, MAGIC)
  assert.equal(symbol.version, WIRE_VERSION)
  assert.equal(symbol.frameType, FRAME_TYPE_SYMBOL)
  assert.equal(symbol.objectIdHex, fixture.three_ids.object_id_hex)
  assert.equal(symbol.sbn, 1)
  assert.equal(symbol.esi, 42)
  // A SYMBOL frame's payload is exactly one wire symbol (body_len == T).
  const expectedT = 0x0100 // fixture uses T = 256 (min wire symbol size)
  assert.equal(symbol.bodyLen, expectedT)
  assert.equal(
    fixture.symbol_frame_hex.length / 2,
    26 + symbol.bodyLen + 4,
    "frame length must be header + T payload + trailing CRC32"
  )
})
