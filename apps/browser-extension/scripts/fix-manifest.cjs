/**
 * Post-build manifest fixup.
 *
 * Plasmo generates the manifest from a single shared config in package.json.
 * MV2 and Firefox have subtle differences that Plasmo does not fully handle:
 *
 *  1. MV2: `action` must be removed (only `browser_action` is valid).
 *  2. MV2: CSP must be a plain string (not an object) and `wasm-unsafe-eval`
 *     is MV3-only — in MV2 the equivalent is `wasm-eval`.
 *  3. Firefox: needs an explicit `browser_specific_settings.gecko.id`.
 *  4. All: patch <title>undefined</title> → proper page title in HTML.
 */
const fs = require("fs");
const path = require("path");

const buildDir = path.resolve(__dirname, "..", "build");
const target = process.argv[2]; // e.g. "chrome-mv2-prod"
if (!target) {
  console.error("Usage: node fix-manifest.cjs <target-dir-name>");
  process.exit(1);
}

const targetDir = path.join(buildDir, target);
const manifestPath = path.join(targetDir, "manifest.json");

if (!fs.existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
const isMV2 = manifest.manifest_version === 2;
const isFirefox = target.includes("firefox");

// 1. Icons: copy the real RGBA icons from assets/ into the build dir and
//    point the manifest at them. Plasmo generates tiny 1-bit placeholder
//    icons (icon16.plasmo.*.png etc.) which look broken, so we overwrite the
//    manifest.icon references with our own copied files.
const iconAssetsDir = path.resolve(__dirname, "..", "assets");
const icons = {
  "16": "icon16.png",
  "32": "icon32.png",
  "48": "icon48.png",
  "64": "icon64.png",
  "128": "icon128.png",
};

for (const fname of Object.values(icons)) {
  const src = path.join(iconAssetsDir, fname);
  const dst = path.join(targetDir, fname);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    // Remove Plasmo placeholder icon for this size to avoid confusion.
    const prefix = fname.replace(/\.png$/, "");
    for (const f of fs.readdirSync(targetDir)) {
      if (f.startsWith(`${prefix}.plasmo.`) && f.endsWith(".png")) {
        fs.unlinkSync(path.join(targetDir, f));
      }
    }
  }
}

manifest.icons = icons;

if (isMV2) {
  if (manifest.browser_action) {
    manifest.browser_action.default_icon = icons;
    manifest.browser_action.default_title = "易传 - 离线文件传输";
  }
  if (manifest.action) delete manifest.action;
} else {
  // MV3: ensure action.default_icon is set
  if (manifest.action) {
    manifest.action.default_icon = icons;
    manifest.action.default_title = "易传 - 离线文件传输";
  }
}

// 2. MV2: CSP must be a string with wasm-eval (not wasm-unsafe-eval).
if (isMV2) {
  manifest.content_security_policy =
    "script-src 'self' 'wasm-eval'; object-src 'self'";
}

// 3. Firefox: add browser_specific_settings.
if (isFirefox) {
  manifest.browser_specific_settings = {
    gecko: {
      id: "easytransfer@easytransfer.app",
      strict_min_version: isMV2 ? "91.0" : "109.0",
    },
  };
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`✓ Fixed manifest: ${target}`);

// 4. Patch <title>undefined</title> in all HTML files.
const htmlFiles = fs
  .readdirSync(targetDir)
  .filter((f) => f.endsWith(".html"));
for (const f of htmlFiles) {
  const fp = path.join(targetDir, f);
  let html = fs.readFileSync(fp, "utf-8");
  if (html.includes("<title>undefined</title>")) {
    html = html.replace(
      /<title>undefined<\/title>/g,
      "<title>易传 · 文件传输</title>"
    );
    fs.writeFileSync(fp, html);
    console.log(`  ✓ Patched <title> in ${f}`);
  }
}
