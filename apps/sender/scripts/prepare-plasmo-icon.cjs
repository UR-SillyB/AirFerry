/**
 * Plasmo requires assets/icon.png before it can generate its intermediate
 * manifest. fix-manifest.cjs later installs the real per-size icons, so this
 * disposable source is generated from the canonical 128px asset.
 */
const fs = require("fs");
const path = require("path");

const assets = path.resolve(__dirname, "../assets");
const source = path.join(assets, "icon128.png");
const target = path.join(assets, "icon.png");

if (!fs.existsSync(source)) {
  throw new Error(`canonical extension icon missing: ${source}`);
}
fs.copyFileSync(source, target);
console.log(`[prepare-plasmo-icon] ${path.relative(process.cwd(), target)}`);
