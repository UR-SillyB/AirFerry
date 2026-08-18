/** Recovered payload types shared by the receive worker and the result UI.
 *
 * The AF2 pipeline recovers text / single-file / bundle results inside the
 * Rust WASM receiver; these types describe what crosses the worker boundary.
 */

export type RecoveredKind = "text" | "bundle" | "file"

export interface RecoveredText {
  kind: "text"
  text: string
  validUtf8: boolean
  name?: string
}

export interface RecoveredFile {
  kind: "file"
  name: string
  data: Blob
}

export interface RecoveredBundle {
  kind: "bundle"
  entries: RecoveredFile[]
}

export type Recovered = RecoveredText | RecoveredFile | RecoveredBundle
