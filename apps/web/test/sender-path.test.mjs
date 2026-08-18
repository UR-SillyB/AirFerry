import assert from "node:assert/strict"
import test from "node:test"

import { normalizeSenderPath, senderPathForFile, uniqueSenderPath } from "../src/lib/sender-path.ts"
import { AF2_MAX_ORIGINAL_BYTES, MAX_ORIGINAL_BYTES, MAX_ORIGINAL_MIB } from "../src/types.ts"

test("Web sender host limit stays below the AF2 wire capacity while whole-buffered", () => {
  assert.equal(MAX_ORIGINAL_MIB, 256)
  assert.equal(MAX_ORIGINAL_BYTES, 256 * 1024 * 1024)
  assert.ok(MAX_ORIGINAL_BYTES < AF2_MAX_ORIGINAL_BYTES)
})

test("senderPathForFile preserves directory picker hierarchy", () => {
  assert.equal(
    senderPathForFile({ name: "foo.txt", webkitRelativePath: "Root/A/foo.txt" }),
    "Root/A/foo.txt"
  )
  assert.equal(
    senderPathForFile({ name: "foo.txt", webkitRelativePath: "Root/B/foo.txt" }),
    "Root/B/foo.txt"
  )
})

test("senderPathForFile prefers the explicit sibling path over the File property", () => {
  // Structured clone of a File re-serializes the browser-native
  // webkitRelativePath field (empty for picked/walked files); the JS-level
  // override is invisible across postMessage. The hierarchy therefore travels
  // as an explicit sibling path and must win — including over a blank native
  // field and over a stale native one.
  assert.equal(
    senderPathForFile({ name: "foo.txt", webkitRelativePath: "" }, "Root/A/foo.txt"),
    "Root/A/foo.txt"
  )
  assert.equal(
    senderPathForFile({ name: "foo.txt", webkitRelativePath: "stale/foo.txt" }, "Root/B/foo.txt"),
    "Root/B/foo.txt"
  )
  // Without an override the old behavior stands (native rel path, then name).
  assert.equal(
    senderPathForFile({ name: "plain.txt", webkitRelativePath: "" }),
    "plain.txt"
  )
})

test("uniqueSenderPath only renames a true full-path collision", () => {
  const used = new Set(["Root/A/foo.txt", "Root/B/foo.txt"])
  assert.equal(uniqueSenderPath(used, "Root/C/foo.txt"), "Root/C/foo.txt")
  assert.equal(uniqueSenderPath(used, "Root/A/foo.txt"), "Root/A/foo (1).txt")
})

test("normalizeSenderPath canonicalizes separators and rejects traversal", () => {
  assert.equal(normalizeSenderPath("Root\\A\\e\u0301.txt"), "Root/A/é.txt")
  assert.throws(() => normalizeSenderPath("Root/../secret.txt"), /包含 \.\./)
})
