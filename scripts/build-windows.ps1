<#
.SYNOPSIS
  AirFerry Windows 端一键构建脚本（PowerShell 原生版，首选）。

.DESCRIPTION
  对标 scripts/build-all.sh 的 scanner 子命令，但面向 Windows + .NET 8 SDK。
  流程：① 编译 Rust C ABI (transfer_engine.dll, --features cffi) → 拷 runtime/
       ② dotnet restore + publish → 打包 zip 到 dist/。

  这是 Windows 端的权威构建路径；build-all.sh 的 windows 子命令是 Git
  Bash/WSL 下的回退入口，逻辑等价。

.PARAMETER Pack
  打包到 dist/（等价 build-all.sh release 的 Windows 部分）。缺省只构建。

.EXAMPLE
  # 仅构建
  .\scripts\build-windows.ps1
  # 构建 + 打包到 dist/
  .\scripts\build-windows.ps1 -Pack
#>

[CmdletBinding()]
param(
    [switch]$Pack
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path "$PSScriptRoot/.."

function Info($msg) { Write-Host "[OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "[X] $msg" -ForegroundColor Red; exit 1 }

# 版本号取自 apps/sender/package.json（与 build-all.sh 同源）。
$Pkg = Get-Content "$Root/apps/sender/package.json" -Raw | ConvertFrom-Json
$Ver = $Pkg.version
Info "AirFerry Windows 构建 (v$Ver)"

# ── ① Rust C ABI DLL ────────────────────────────────────────────────────
# 必须在 dotnet build 之前：csproj 把 runtime/transfer_engine.dll 标为
# CopyToOutputDirectory，缺失会导致运行时 DllNotFoundException（对标 Android
# jniLibs 缺 .so 的 UnsatisfiedLinkError）。
Info "编译 Rust C ABI (core/transfer-engine --features cffi -> transfer_engine.dll) ..."
Push-Location $Root
cargo build -p transfer-engine --features cffi --release
if ($LASTEXITCODE -ne 0) { Fail "Rust 编译失败" }
Pop-Location

$DllSrc = "$Root/target/release/transfer_engine.dll"
if (-not (Test-Path $DllSrc)) {
    Fail "未找到 $DllSrc — 请确认在 Windows 上运行且 target 为 x86_64-pc-windows-msvc"
}
$RuntimeDir = "$Root/apps/windows/AirFerry.Windows/runtime"
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
Copy-Item $DllSrc "$RuntimeDir/transfer_engine.dll" -Force
Info "Rust DLL -> apps/windows/AirFerry.Windows/runtime/transfer_engine.dll"

# ── ② C# WPF 构建 ───────────────────────────────────────────────────────
Info "还原 NuGet 包 ..."
Push-Location "$Root/apps/windows"
dotnet restore
if ($LASTEXITCODE -ne 0) { Fail "dotnet restore 失败" }

if ($Pack) {
    Info "发布 (self-contained=false, single-file) ..."
    dotnet publish AirFerry.Windows/AirFerry.Windows.csproj `
        -c Release -r win-x64 `
        -p:PublishSingleFile=true --self-contained false
    if ($LASTEXITCODE -ne 0) { Fail "dotnet publish 失败" }

    $PublishDir = "$Root/apps/windows/AirFerry.Windows/bin/x64/Release/net8.0-windows/publish"
    if (-not (Test-Path $PublishDir)) { Fail "未找到发布产物: $PublishDir" }

    $DistDir = "$Root/dist"
    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
    $ZipName = "airferry-windows-x64-v$Ver.zip"
    $ZipPath = "$DistDir/$ZipName"
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Compress-Archive -Path "$PublishDir/*" -DestinationPath $ZipPath
    Info "Windows 端 -> dist/$ZipName"
} else {
    Info "构建 (Debug 配置) ..."
    dotnet build -c Release
    if ($LASTEXITCODE -ne 0) { Fail "dotnet build 失败" }
}
Pop-Location

Info "Windows 端构建完成!"
