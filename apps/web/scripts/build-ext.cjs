/**
 * Build all four extension targets sequentially using Vite.
 *
 * Outputs:
 *   build/chrome-mv3-prod/
 *   build/chrome-mv2-prod/
 *   build/firefox-mv3-prod/
 *   build/firefox-mv2-prod/
 */
const fs = require("fs")
const path = require("path")
const { acquireWasmLock } = require("./wasm-lock.cjs")

const root = path.resolve(__dirname, "..")

const targets = [
  "chrome-mv3",
  "chrome-mv2",
  "firefox-mv3",
  "firefox-mv2",
]
const requested = process.argv.slice(2)
const selectedTargets = requested.length === 0 ? targets : requested
for (const target of selectedTargets) {
  if (!targets.includes(target)) {
    console.error(`Unknown target: ${target}`)
    process.exit(2)
  }
}

function ensureWasmPkg() {
  const pkg = path.join(root, "wasm-pkg")
  for (const f of ["transfer_engine.js", "transfer_engine_bg.wasm"]) {
    if (!fs.existsSync(path.join(pkg, f))) {
      console.error(
        `\n✖ wasm-pkg/${f} missing. Run \`npm run wasm\` (scripts/build-wasm.cjs) first.`
      )
      process.exit(1)
    }
  }
}

function generateManifest(target, version) {
  const isMV2 = target.endsWith("-mv2")
  const isFirefox = target.startsWith("firefox-")

  const icons = {
    "16": "icon16.png",
    "32": "icon32.png",
    "48": "icon48.png",
    "64": "icon64.png",
    "128": "icon128.png",
  }

  const manifest = {
    manifest_version: isMV2 ? 2 : 3,
    name: "AirFerry - 无网文件传输",
    description: "通过屏幕二维码视频流，无网传输文件到手机。无需网络、蓝牙、USB。",
    version,
    icons,
    permissions: [],
  }

  if (isMV2) {
    manifest.browser_action = {
      default_icon: icons,
      default_title: "AirFerry - 无网文件传输",
    }
    manifest.background = {
      scripts: ["background.js"],
      persistent: false,
    }
    manifest.content_security_policy = "script-src 'self' 'wasm-eval'; object-src 'self'"
  } else {
    manifest.action = {
      default_icon: icons,
      default_title: "AirFerry - 无网文件传输",
    }
    if (isFirefox) {
      manifest.background = {
        scripts: ["background.js"],
      }
    } else {
      manifest.background = {
        service_worker: "background.js",
      }
    }
    manifest.content_security_policy = {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    }
  }

  if (isFirefox) {
    manifest.browser_specific_settings = {
      gecko: {
        id: "airferry@airferry.app",
        strict_min_version: isMV2 ? "91.0" : "116.0",
      },
    }
  }

  return manifest
}

async function buildTarget(target, version, viteBuild, reactPlugin) {
  const outDir = path.join(root, "build", `${target}-prod`)
  console.log(`\n▶ Building target: ${target} → ${path.relative(root, outDir)}`)

  fs.rmSync(outDir, { recursive: true, force: true })

  // 1. Build options page + workers + WASM with Vite
  await viteBuild({
    root,
    configFile: false,
    plugins: [reactPlugin()],
    resolve: {
      alias: [
        { find: "@/icons", replacement: path.resolve(root, "src/components/icons.tsx") },
        { find: "@/", replacement: path.resolve(root, "src/") + "/" },
        { find: "@airferry-wasm/", replacement: path.resolve(root, "wasm-pkg/") + "/" },
      ],
    },
    worker: {
      format: "es",
    },
    base: "./",
    build: {
      outDir,
      emptyOutDir: false,
      target: ["chrome87", "firefox91"],
      rollupOptions: {
        input: {
          options: path.resolve(root, "options.html"),
        },
      },
    },
  })

  // 2. Build background script as IIFE
  await viteBuild({
    root,
    configFile: false,
    build: {
      outDir,
      emptyOutDir: false,
      target: ["chrome87", "firefox91"],
      lib: {
        entry: path.resolve(root, "src/background/index.ts"),
        name: "AirFerryBackground",
        formats: ["iife"],
        fileName: () => "background.js",
      },
    },
  })

  // 3. Copy icons
  const iconAssetsDir = path.resolve(root, "assets")
  for (const size of ["16", "32", "48", "64", "128"]) {
    const iconName = `icon${size}.png`
    const src = path.join(iconAssetsDir, iconName)
    const dst = path.join(outDir, iconName)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst)
    }
  }

  // Also copy icon.png into assets/ for options.html favicon
  const outAssetsDir = path.join(outDir, "assets")
  fs.mkdirSync(outAssetsDir, { recursive: true })
  const iconSrc = path.join(iconAssetsDir, "icon.png")
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(outAssetsDir, "icon.png"))
  }

  // 4. Generate manifest.json
  const manifest = generateManifest(target, version)
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2))
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"))
  const version = pkg.version

  const { build: viteBuild } = await import("vite")
  const { default: reactPlugin } = await import("@vitejs/plugin-react")

  const releaseLock = acquireWasmLock(root)
  try {
    ensureWasmPkg()
    for (const target of selectedTargets) {
      await buildTarget(target, version, viteBuild, reactPlugin)
    }
  } finally {
    releaseLock()
  }

  console.log("\n✅ All targets built:")
  for (const target of selectedTargets) {
    console.log(`   build/${target}-prod/`)
  }
}

main().catch((err) => {
  console.error("Build failed:", err)
  process.exit(1)
})
