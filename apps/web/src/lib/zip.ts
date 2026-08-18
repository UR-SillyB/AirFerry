/**
 * Zero-dependency ZIP/ZIP64 Store-mode archiver.
 *
 * Entry bodies are Blob-backed and are appended to the resulting Blob without
 * first materializing them as Uint8Array. CRC32 is calculated incrementally
 * from Blob.stream(), so multi-gigabyte received bundles stay bounded-memory.
 */

const CRC32_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC32_TABLE[i] = c >>> 0
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function crc32Blob(blob: Blob): Promise<number> {
  let crc = 0xffffffff
  const reader = blob.stream().getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (let i = 0; i < value.length; i++) {
        crc = CRC32_TABLE[(crc ^ value[i]) & 0xff] ^ (crc >>> 8)
      }
    }
  } finally {
    reader.releaseLock()
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntryInput {
  name: string
  data: Blob | Uint8Array
  mtime?: Date
}

function dateToDosTimeDate(d: Date): { dosTime: number; dosDate: number } {
  const year = d.getFullYear()
  const month = d.getMonth() + 1
  const day = d.getDate()
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  // DOS date field is 7 bits for (year-1980) — clamp to the representable
  // range instead of letting it overflow the u16 field.
  const dosYear = Math.min(2107, Math.max(1980, year)) - 1980
  const dosDate = (dosYear << 9) | (month << 5) | day
  return { dosTime, dosDate }
}

function setU64(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value, true)
}

function zip64Extra(values: bigint[]): Uint8Array {
  const extra = new Uint8Array(4 + values.length * 8)
  const view = new DataView(extra.buffer)
  view.setUint16(0, 0x0001, true)
  view.setUint16(2, values.length * 8, true)
  values.forEach((value, index) => setU64(view, 4 + index * 8, value))
  return extra
}

function asBlob(data: Blob | Uint8Array): Blob {
  if (data instanceof Blob) return data
  // Compatibility for existing callers/tests; received files already arrive
  // as Blob and therefore avoid this snapshot path entirely.
  const owned = new Uint8Array(data.byteLength)
  owned.set(data)
  return new Blob([owned.buffer])
}

/** Create a Store-mode ZIP archive, automatically emitting ZIP64 when needed. */
export async function createZipBlob(entries: ZipEntryInput[]): Promise<Blob> {
  const encoder = new TextEncoder()
  const localParts: BlobPart[] = []
  const centralParts: BlobPart[] = []
  let currentOffset = 0n

  for (const entry of entries) {
    const cleanPath = entry.name.replace(/\\/g, "/")
    const encodedName = encoder.encode(cleanPath)
    if (encodedName.length > 0xffff) throw new Error(`ZIP 文件名过长: ${entry.name}`)
    const data = asBlob(entry.data)
    const dataLen = BigInt(data.size)
    const localOffset = currentOffset
    const entryCrc = await crc32Blob(data)
    const { dosTime, dosDate } = dateToDosTimeDate(entry.mtime ?? new Date())
    const needsZip64 = dataLen >= 0xffffffffn || localOffset >= 0xffffffffn
    const localExtra = needsZip64 ? zip64Extra([dataLen, dataLen]) : new Uint8Array(0)

    const localHeader = new Uint8Array(30 + encodedName.length + localExtra.length)
    const lView = new DataView(localHeader.buffer)
    lView.setUint32(0, 0x04034b50, true)
    lView.setUint16(4, needsZip64 ? 45 : 20, true)
    lView.setUint16(6, 0x0800, true)
    lView.setUint16(8, 0, true)
    lView.setUint16(10, dosTime, true)
    lView.setUint16(12, dosDate, true)
    lView.setUint32(14, entryCrc, true)
    lView.setUint32(18, needsZip64 ? 0xffffffff : Number(dataLen), true)
    lView.setUint32(22, needsZip64 ? 0xffffffff : Number(dataLen), true)
    lView.setUint16(26, encodedName.length, true)
    lView.setUint16(28, localExtra.length, true)
    localHeader.set(encodedName, 30)
    localHeader.set(localExtra, 30 + encodedName.length)
    localParts.push(localHeader, data)
    currentOffset += BigInt(localHeader.length) + dataLen

    const cdExtra = needsZip64 ? zip64Extra([dataLen, dataLen, localOffset]) : new Uint8Array(0)
    const cdHeader = new Uint8Array(46 + encodedName.length + cdExtra.length)
    const cdView = new DataView(cdHeader.buffer)
    cdView.setUint32(0, 0x02014b50, true)
    cdView.setUint16(4, needsZip64 ? 45 : 20, true)
    cdView.setUint16(6, needsZip64 ? 45 : 20, true)
    cdView.setUint16(8, 0x0800, true)
    cdView.setUint16(10, 0, true)
    cdView.setUint16(12, dosTime, true)
    cdView.setUint16(14, dosDate, true)
    cdView.setUint32(16, entryCrc, true)
    cdView.setUint32(20, needsZip64 ? 0xffffffff : Number(dataLen), true)
    cdView.setUint32(24, needsZip64 ? 0xffffffff : Number(dataLen), true)
    cdView.setUint16(28, encodedName.length, true)
    cdView.setUint16(30, cdExtra.length, true)
    cdView.setUint16(32, 0, true)
    cdView.setUint16(34, 0, true)
    cdView.setUint16(36, 0, true)
    cdView.setUint32(38, 0, true)
    cdView.setUint32(42, needsZip64 ? 0xffffffff : Number(localOffset), true)
    cdHeader.set(encodedName, 46)
    cdHeader.set(cdExtra, 46 + encodedName.length)
    centralParts.push(cdHeader)
  }

  const cdOffset = currentOffset
  const cdSize = centralParts.reduce((sum, p) => sum + BigInt((p as Uint8Array).byteLength), 0n)
  const count = BigInt(entries.length)
  const needsZip64Eocd = count >= 0xffffn || cdSize >= 0xffffffffn || cdOffset >= 0xffffffffn
  const trailer: BlobPart[] = []

  if (needsZip64Eocd) {
    const zip64EocdOffset = cdOffset + cdSize
    const zip64Eocd = new Uint8Array(56)
    const z = new DataView(zip64Eocd.buffer)
    z.setUint32(0, 0x06064b50, true)
    setU64(z, 4, 44n)
    z.setUint16(12, 45, true)
    z.setUint16(14, 45, true)
    z.setUint32(16, 0, true)
    z.setUint32(20, 0, true)
    setU64(z, 24, count)
    setU64(z, 32, count)
    setU64(z, 40, cdSize)
    setU64(z, 48, cdOffset)

    const locator = new Uint8Array(20)
    const loc = new DataView(locator.buffer)
    loc.setUint32(0, 0x07064b50, true)
    loc.setUint32(4, 0, true)
    setU64(loc, 8, zip64EocdOffset)
    loc.setUint32(16, 1, true)
    trailer.push(zip64Eocd, locator)
  }

  const eocd = new Uint8Array(22)
  const e = new DataView(eocd.buffer)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(4, 0, true)
  e.setUint16(6, 0, true)
  e.setUint16(8, Number(count > 0xffffn ? 0xffffn : count), true)
  e.setUint16(10, Number(count > 0xffffn ? 0xffffn : count), true)
  e.setUint32(12, Number(cdSize > 0xffffffffn ? 0xffffffffn : cdSize), true)
  e.setUint32(16, Number(cdOffset > 0xffffffffn ? 0xffffffffn : cdOffset), true)
  e.setUint16(20, 0, true)
  trailer.push(eocd)

  return new Blob([...localParts, ...centralParts, ...trailer], { type: "application/zip" })
}
