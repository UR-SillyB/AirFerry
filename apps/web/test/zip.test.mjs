import { test } from "node:test"
import assert from "node:assert/strict"
import { createZipBlob, crc32 } from "../src/lib/zip.ts"

test("crc32 calculates correct IEEE standard checksum", () => {
  const encoder = new TextEncoder()
  const data = encoder.encode("123456789")
  assert.equal(crc32(data), 0xcbf43926)
})

test("createZipBlob creates valid PKZIP buffer with local and central directory headers", async () => {
  const encoder = new TextEncoder()
  const file1 = { name: "hello.txt", data: encoder.encode("Hello World!") }
  const file2 = { name: "sub/test.json", data: encoder.encode('{"key": "value"}') }

  const blob = await createZipBlob([file1, file2])
  assert.equal(blob.type, "application/zip")
  assert.ok(blob.size > file1.data.length + file2.data.length)

  const buf = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(buf.buffer)

  // First local file header signature 0x04034b50
  assert.equal(view.getUint32(0, true), 0x04034b50)

  // End of Central Directory signature 0x06054b50 exists near the end
  const eocdSig = view.getUint32(buf.length - 22, true)
  assert.equal(eocdSig, 0x06054b50)
  // Total entries = 2
  assert.equal(view.getUint16(buf.length - 22 + 8, true), 2)
  assert.equal(view.getUint16(buf.length - 22 + 10, true), 2)
})

test("createZipBlob emits ZIP64 fields for a >= 0xffffffff-byte entry without allocating it", async () => {
  class SparseHugeBlob extends Blob {
    get size() {
      return 0xffffffff
    }
    stream() {
      // Header generation uses the logical size above; an empty stream keeps
      // this regression test bounded-memory while still exercising ZIP64.
      return new Blob([]).stream()
    }
  }

  const blob = await createZipBlob([{ name: "huge.bin", data: new SparseHugeBlob([]) }])
  const buf = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(buf.buffer)
  assert.equal(view.getUint32(0, true), 0x04034b50)
  assert.equal(view.getUint16(4, true), 45)
  assert.equal(view.getUint32(18, true), 0xffffffff)
  assert.equal(view.getUint32(22, true), 0xffffffff)
  // ZIP64 extra immediately follows the 30-byte local header + 8-byte name.
  assert.equal(view.getUint16(38, true), 0x0001)
  assert.equal(view.getBigUint64(42, true), 0xffffffffn)

  const findSig = (sig) => {
    for (let i = 0; i <= buf.length - 4; i++) {
      if (view.getUint32(i, true) === sig) return i
    }
    return -1
  }
  assert.ok(findSig(0x06064b50) >= 0, "ZIP64 EOCD must be present")
  assert.ok(findSig(0x07064b50) >= 0, "ZIP64 locator must be present")
})
