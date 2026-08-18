const fs = require("fs")
const path = require("path")

const LOCK_NAME = ".wasm-build.lock"
const OWNER_NAME = "owner.json"
const OWNER_WRITE_GRACE_MS = 30_000

/**
 * Serialize every publisher/consumer of sender WASM package directories.
 * Returns an ownership-checked release callback.
 */
function acquireWasmLock(senderRoot) {
  const lockDir = path.join(senderRoot, LOCK_NAME)
  const ownerPath = path.join(lockDir, OWNER_NAME)

  try {
    fs.mkdirSync(lockDir)
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
    let stale = false
    let initialStat
    let initialOwnerRaw = null
    try {
      initialStat = fs.statSync(lockDir)
      initialOwnerRaw = fs.readFileSync(ownerPath, "utf8")
      const owner = JSON.parse(initialOwnerRaw)
      if (!owner || !Number.isInteger(owner.pid)) {
        stale = Date.now() - initialStat.mtimeMs > OWNER_WRITE_GRACE_MS
      } else {
        try {
          process.kill(owner.pid, 0)
          // A live process owns the lock, however long the build takes.
          stale = false
        } catch {
          stale = true
        }
      }
    } catch {
      // A creator may be between atomic mkdir and owner.json. Do not steal a
      // fresh live lock during that window.
      initialStat = fs.statSync(lockDir)
      stale = Date.now() - initialStat.mtimeMs > OWNER_WRITE_GRACE_MS
    }
    if (!stale) throw new Error("another AirFerry WASM build/use is already running")

    // Elect one stale-lock reclaimer inside the still-existing directory. Then
    // verify the directory inode and owner contents did not change before
    // deleting it. This prevents two contenders from deleting each other's
    // freshly-created replacement lock (the classic stale-lock TOCTOU race).
    const reclaimDir = path.join(lockDir, ".reclaim")
    try {
      fs.mkdirSync(reclaimDir)
    } catch {
      throw new Error("another AirFerry WASM build/use is already running")
    }
    const currentStat = fs.statSync(lockDir)
    let currentOwnerRaw = null
    try {
      currentOwnerRaw = fs.readFileSync(ownerPath, "utf8")
    } catch {
      // A missing owner is valid only when it was also missing in the exact
      // same old directory observed above.
    }
    if (
      currentStat.dev !== initialStat.dev ||
      currentStat.ino !== initialStat.ino ||
      currentOwnerRaw !== initialOwnerRaw
    ) {
      fs.rmSync(reclaimDir, { recursive: true, force: true })
      throw new Error("another AirFerry WASM build/use is already running")
    }
    fs.rmSync(lockDir, { recursive: true, force: true })
    fs.mkdirSync(lockDir)
  }

  const owner = { pid: process.pid, startedAt: new Date().toISOString() }
  fs.writeFileSync(ownerPath, JSON.stringify(owner))
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(ownerPath, "utf8"))
      if (current.pid === process.pid && current.startedAt === owner.startedAt) {
        fs.rmSync(lockDir, { recursive: true, force: true })
      }
    } catch {
      // Never remove a lock whose ownership can no longer be proven.
    }
  }
}

module.exports = { acquireWasmLock }
