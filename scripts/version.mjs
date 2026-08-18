#!/usr/bin/env node
/**
 * Version single-source-of-truth gate.
 *
 * The ROOT `Cargo.toml [workspace.package].version` is the authoritative
 * version. `node scripts/version.mjs check` verifies every version site
 * carries exactly that version, and fails (exit 1) on any drift or on a
 * missing/ambiguous hit — so CI blocks a release whose artifacts would
 * disagree about their own version.
 *
 * Sites checked (see AGENTS.md §3.7 "版本事实源"):
 *   apps/web/package.json                   version (1 hit)
 *   apps/web/package-lock.json              root version + packages[""].version (2 hits)
 *   apps/scanner/app/build.gradle.kts       versionName "x.y.z" (1 hit)
 *   apps/windows/AirFerry.Windows/AirFerry.Windows.csproj  <Version>x.y.z</Version> (1 hit)
 *
 * Android versionCode is a separate monotonically-increasing integer (Android
 * forbids lower/equal versionCode on upgrade), so it cannot be derived from the
 * semantic version. It is registered in [versionCodes] below; the gate verifies
 * the gradle file matches the registered code for the current version AND the
 * table stays strictly increasing. Bump both together on each release.
 *
 * Usage:
 *   node scripts/version.mjs check
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8")
}

/** Authoritative version from the workspace root Cargo.toml. */
function cargoVersion() {
  const toml = read("Cargo.toml")
  const m = toml.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m)
  if (!m) {
    console.error("✗ Cargo.toml: no [workspace.package] version found")
    process.exit(1)
  }
  return m[1]
}

/**
 * A site definition: file + a function that must find EXACTLY `expectHits`
 * occurrences of the version in that file.
 */
const sites = [
  {
    file: "apps/web/package.json",
    desc: 'web "version"',
    countMatches: (text, v) => (JSON.parse(text).version === v ? 1 : 0),
    expected: 1,
  },
  {
    file: "apps/web/package-lock.json",
    desc: 'lockfile root version + packages[""].version',
    countMatches: (text, v) => {
      const lock = JSON.parse(text)
      let hits = 0
      if (lock.version === v) hits++
      if (lock.packages?.[""]?.version === v) hits++
      return hits
    },
    expected: 2,
  },
  {
    file: "apps/scanner/app/build.gradle.kts",
    desc: 'scanner versionName "x.y.z"',
    countMatches: (text, v) =>
      (text.match(new RegExp(`versionName\\s*=\\s*"${escapeRe(v)}"`, "g")) || []).length,
    expected: 1,
  },
  {
    file: "apps/windows/AirFerry.Windows/AirFerry.Windows.csproj",
    desc: "Windows csproj <Version>x.y.z</Version>",
    countMatches: (text, v) =>
      (text.match(new RegExp(`<Version>${escapeRe(v)}</Version>`, "g")) || []).length,
    expected: 1,
  },
]

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Android `versionCode` is a hand-maintained monotonically-increasing integer
 * (Android rejects an upgrade whose versionCode is not strictly greater). It
 * has no math relationship to the semantic version string, so it's registered
 * here and checked against `build.gradle.kts` + table ordering.
 */
const versionCodes = [{ version: "1.2.7", code: 21 }]

function check() {
  const v = cargoVersion()
  let failures = 0

  // versionCode table must stay strictly increasing (Android upgrade rule).
  for (let i = 1; i < versionCodes.length; i++) {
    if (versionCodes[i].code <= versionCodes[i - 1].code) {
      console.error(
        `✗ versionCode table not strictly increasing: ${versionCodes[i - 1].version}=${versionCodes[i - 1].code} → ${versionCodes[i].version}=${versionCodes[i].code}`
      )
      failures++
    }
  }
  const vc = versionCodes.find((e) => e.version === v)
  if (!vc) {
    console.error(`✗ no versionCode registered for ${v} — bump it in scripts/version.mjs`)
    failures++
  }

  for (const site of sites) {
    let text
    try {
      text = read(site.file)
    } catch {
      console.error(`✗ ${site.file}: file missing`)
      failures++
      continue
    }
    let hits
    try {
      hits = site.countMatches(text, v)
    } catch (e) {
      console.error(`✗ ${site.file}: parse failed (${e.message})`)
      failures++
      continue
    }
    if (hits !== site.expected) {
      console.error(
        `✗ ${site.file}: expected ${site.expected} hit(s) of ${v} (${site.desc}), found ${hits}`
      )
      failures++
    }
  }

  const gradle = read("apps/scanner/app/build.gradle.kts")
  const vcHits = vc ? (gradle.match(new RegExp(`versionCode\\s*=\\s*${vc.code}\\b`)) || []).length : 0
  if (vcHits !== 1) {
    console.error(
      `✗ build.gradle.kts: expected versionCode = ${vc?.code} for ${v}, found ${vcHits}`
    )
    failures++
  }

  if (failures > 0) {
    console.error(`version check FAILED for ${v} (${failures} issue(s))`)
    process.exit(1)
  }
  console.log(`version check OK: all ${sites.length} sites + versionCode at ${v}`)
}

const cmd = process.argv[2] ?? "check"
switch (cmd) {
  case "check":
    check()
    break
  default:
    console.error(`unknown command: ${cmd} (supported: check)`)
    process.exit(2)
}
