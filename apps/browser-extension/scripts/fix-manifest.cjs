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

// 1. MV2: remove `action`, keep only `browser_action`.
if (isMV2) {
  if (manifest.browser_action && manifest.action) {
    // Merge default_title into browser_action if not already present.
    if (manifest.action.default_title && !manifest.browser_action.default_title) {
      manifest.browser_action.default_title = manifest.action.default_title;
    }
    delete manifest.action;
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
