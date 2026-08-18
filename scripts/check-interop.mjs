#!/usr/bin/env node
/**
 * AF2 四端互操作检查运行器（计划 F1 矩阵的执行载体）。
 *
 * 跑通四端各自的测试套件 + 版本门禁，输出互操作矩阵状态表：
 *   Rust 核心（协议语义 + golden vectors 全量往返，唯一权威）
 *   Web    （类型检查 + 单测：golden 帧头级断言）
 *   Android（单测：golden 帧头级 + 宿主崩溃间隙）
 *   Windows（单测：golden 帧头级 + 宿主崩溃间隙）
 *
 * 任一端失败退出码非零。物理链路（摄像头/采集卡/屏幕捕获 → QR 解码）
 * 无法在 CI 自动化，见 docs/interop-matrix.md 的人工验收清单。
 *
 * Usage: node scripts/check-interop.mjs
 */
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWin = process.platform === "win32"

const results = []

function run(name, cmd, args, opts = {}) {
  const start = Date.now()
  try {
    // Windows cannot exec .cmd/.bat files directly through execFileSync.
    // Route those wrappers through cmd.exe while keeping native executables
    // (cargo/node/dotnet) shell-free on every platform.
    const needsCmd = isWin && /\.(?:cmd|bat)$/i.test(cmd)
    const actualCmd = needsCmd ? (process.env.ComSpec || "cmd.exe") : cmd
    const actualArgs = needsCmd ? ["/d", "/s", "/c", cmd, ...args] : args
    execFileSync(actualCmd, actualArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    })
    results.push({ name, ok: true, ms: Date.now() - start, detail: "" })
  } catch (e) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - start,
      detail: (e.stderr || e.stdout || e.message || "").toString().split("\n").slice(-4).join("\n"),
    })
  }
}

console.log("▶ AF2 四端互操作矩阵检查\n")

run("Rust 核心 + golden vectors", "cargo", ["test", "--workspace"], { timeout: 600000 })
run("Rust clippy 门禁", "cargo", ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"], { timeout: 600000 })
run("Web 类型检查", isWin ? "npm.cmd" : "npm", ["--prefix", "apps/web", "run", "typecheck"], { timeout: 300000 })
run("Web 单测（golden 帧头）", isWin ? "npm.cmd" : "npm", ["--prefix", "apps/web", "test"], { timeout: 300000 })
run(
  "Android 单测",
  isWin ? path.join(root, "apps/scanner/gradlew.bat") : "apps/scanner/gradlew",
  ["--project-dir", "apps/scanner", ":app:testDebugUnitTest"],
  { timeout: 600000 }
)

// .NET SDK probe: the real binary may exist at /usr/local/share/dotnet/dotnet
// without being on PATH (common on arm64 macOS); resolve the usable spelling
// first so the probe and the test run use the same binary — otherwise a
// PATH-missing dotnet turns a legitimate SKIP into a FAIL.
let dotnetBin = null
for (const candidate of ["dotnet", "/usr/local/share/dotnet/dotnet"]) {
  try {
    const sdkList = execFileSync(candidate, ["--list-sdks"], { cwd: root, encoding: "utf8" })
    if (sdkList.trim().length > 0) {
      dotnetBin = candidate
      break
    }
  } catch {}
}
if (dotnetBin) {
  run("Windows 单测", dotnetBin, ["test", "apps/windows/AirFerry.Windows.Tests"], { timeout: 600000 })
} else {
  results.push({ name: "Windows 单测", ok: null, ms: 0, detail: ".NET SDK 不可用，跳过（CI windows-latest 覆盖）" })
}
run("版本门禁", "node", ["scripts/version.mjs", "check"], { timeout: 120000 })

console.log("┌──────────────────────────┬────────┬──────────┐")
console.log("│ 端 / 门禁                 │ 状态   │ 耗时     │")
console.log("├──────────────────────────┼────────┼──────────┤")
let allOk = true
for (const r of results) {
  const status = r.ok === true ? "PASS" : r.ok === null ? "SKIP" : "FAIL"
  if (r.ok === false) allOk = false
  console.log(
    `│ ${r.name.padEnd(24)} │ ${status.padEnd(6)} │ ${String(r.ms).padStart(5)} ms │`
  )
  if (r.ok === false) {
    console.log(`│  └─ ${r.detail.replace(/\n/g, "\n│     ").slice(0, 200)}`)
  }
}
console.log("└──────────────────────────┴────────┴──────────┘")
console.log(
  allOk
    ? "\n✅ 互操作矩阵全绿：线格式四端一致（golden vectors + 协议语义由 Rust 权威覆盖）。\n   物理链路验收见 docs/interop-matrix.md。"
    : "\n❌ 存在失败项，矩阵未通过。"
)
process.exit(allOk ? 0 : 1)
