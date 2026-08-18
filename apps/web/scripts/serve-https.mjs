// Minimal HTTPS static file server for LAN receiver testing.
// Usage: node serve-https.mjs <dir> <crt> <key> [port]
import https from "node:https"
import fs from "node:fs"
import path from "node:path"

const [,, dir, crt, key, portArg] = process.argv
const port = Number(portArg) || 8765
if (!dir || !crt || !key) {
  console.error("usage: node serve-https.mjs <serveDir> <crt> <key> [port]")
  process.exit(1)
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".png": "image/png",
}

const server = https.createServer(
  { cert: fs.readFileSync(crt), key: fs.readFileSync(key) },
  (req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0])
    const filePath = path.resolve(dir, urlPath === "/" ? "receiver.html" : urlPath)
    // Boundary-aware containment: a plain startsWith(dir) also admits sibling
    // directories that share the prefix (e.g. dist vs dist-standalone).
    const root = path.resolve(dir)
    const contained = filePath === root || filePath.startsWith(root + path.sep)
    if (!contained || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); res.end("not found"); return
    }
    res.writeHead(200, { "content-type": types[path.extname(filePath)] || "application/octet-stream" })
    fs.createReadStream(filePath).pipe(res)
  }
)

server.listen(port, "0.0.0.0", () => {
  console.log(`HTTPS server serving ${dir} on 0.0.0.0:${port}`)
  console.log(`  本机:   https://localhost:${port}/receiver.html`)
  console.log(`  局域网: https://192.168.242.149:${port}/receiver.html`)
  console.log(`  (自签证书 — 浏览器会警告，点「高级」→「继续」即可)`)
})
