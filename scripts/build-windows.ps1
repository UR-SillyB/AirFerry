<#
.SYNOPSIS
  AirFerry Windows 端一键构建脚本（PowerShell 原生版，首选）。

.DESCRIPTION
  对标 scripts/build-all.sh 的 scanner 子命令，但面向 Windows + .NET 8 SDK。
  流程：① 编译 Rust C ABI (transfer_engine.dll, --features cffi)
       ② 编译共享 ZXing-C++ 解码器 (airferry_zxing.dll)
       ③ dotnet restore + publish → 打包 zip 到 dist/。

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

# 版本号取自 apps/web/package.json（与 build-all.sh 同源）。
$Pkg = Get-Content "$Root/apps/web/package.json" -Raw | ConvertFrom-Json
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

# ── ② shared ZXing-C++ DLL ──────────────────────────────────────────────
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    Fail "未找到 CMake；Windows 原生二维码解码器需要 CMake 3.22+"
}
$NativeSource = "$Root/apps/windows/native"
$NativeBuild = "$NativeSource/build"
Info "编译共享 ZXing-C++ 解码器 (airferry_zxing.dll) ..."
cmake -S $NativeSource -B $NativeBuild -G "Visual Studio 17 2022" -A x64
if ($LASTEXITCODE -ne 0) { Fail "ZXing-C++ CMake 配置失败" }
cmake --build $NativeBuild --config Release --parallel
if ($LASTEXITCODE -ne 0) { Fail "ZXing-C++ 编译失败" }
ctest --test-dir $NativeBuild -C Release --output-on-failure
if ($LASTEXITCODE -ne 0) { Fail "ZXing-C++ 单元测试失败" }
$ZxingDll = Get-ChildItem -Path $NativeBuild -Recurse -File -Filter "airferry_zxing.dll" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($null -eq $ZxingDll) { Fail "未找到 airferry_zxing.dll" }
Copy-Item $ZxingDll.FullName "$RuntimeDir/airferry_zxing.dll" -Force
Info "ZXing-C++ DLL -> apps/windows/AirFerry.Windows/runtime/airferry_zxing.dll"

# ── ③ C# WPF 构建 ───────────────────────────────────────────────────────
Info "还原 NuGet 包 ..."
Push-Location "$Root/apps/windows"
dotnet restore
if ($LASTEXITCODE -ne 0) { Fail "dotnet restore 失败" }

if ($Pack) {
    Info "发布 (self-contained=false, single-file) ..."
    $PublishDir = "$Root/apps/windows/AirFerry.Windows/bin/x64/Release/net8.0-windows/win-x64/publish"
    dotnet publish AirFerry.Windows/AirFerry.Windows.csproj `
        -c Release -r win-x64 `
        -p:PublishSingleFile=true --self-contained false `
        -o $PublishDir
    if ($LASTEXITCODE -ne 0) { Fail "dotnet publish 失败" }

    if (-not (Test-Path $PublishDir)) { Fail "未找到发布产物: $PublishDir" }
    foreach ($RequiredDll in @("transfer_engine.dll", "airferry_zxing.dll")) {
        $RuntimeDll = "$RuntimeDir/$RequiredDll"
        if (-not (Test-Path $RuntimeDll)) {
            Fail "runtime 目录缺少 native 依赖: $RequiredDll"
        }
        # 显式放到单文件 exe 同目录，避免 SDK 默认 item glob / publish 规则变化
        # 造成 P/Invoke DLL 静默漏包。
        Copy-Item $RuntimeDll "$PublishDir/$RequiredDll" -Force
        if (-not (Test-Path "$PublishDir/$RequiredDll")) {
            Fail "发布目录缺少 native 依赖: $RequiredDll"
        }
    }

    $DistDir = "$Root/dist"
    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
    $ZipName = "airferry-receiver-windows-x64-v$Ver.zip"
    $ZipPath = "$DistDir/$ZipName"
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    Compress-Archive -Path "$PublishDir/*" -DestinationPath $ZipPath
    Info "Windows 接收端 -> dist/$ZipName"
} else {
    Info "构建 (Debug 配置) ..."
    dotnet build -c Release
    if ($LASTEXITCODE -ne 0) { Fail "dotnet build 失败" }
}
Pop-Location

Info "Windows 端构建完成!"
