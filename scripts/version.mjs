/* global console, process */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageFiles = [
  "package.json",
  "apps/gateway/package.json",
  "apps/watch/package.json",
  "apps/web/package.json",
  "apps/updater/package.json",
  "ui/package.json",
  "packages/contract/package.json",
  "packages/core/package.json",
  "packages/installer/package.json",
  "packages/adapters/hermes/package.json",
  "packages/adapters/openclaw/package.json",
];
const sourceVersions = [
  {
    file: "packages/core/src/index.ts",
    pattern: /core@[0-9A-Za-z.+-]+\+\$\{CONTRACT_VERSION\}/,
    value: (version) => `core@${version}+\${CONTRACT_VERSION}`,
  },
  {
    file: "apps/web/src/server.ts",
    pattern: /web@[0-9A-Za-z.+-]+\+\$\{CONTRACT_VERSION\}/,
    value: (version) => `web@${version}+\${CONTRACT_VERSION}`,
  },
  {
    file: "apps/watch/src/http.ts",
    pattern: /watch@[0-9A-Za-z.+-]+\+\$\{CONTRACT_VERSION\}/,
    value: (version) => `watch@${version}+\${CONTRACT_VERSION}`,
  },
  {
    file: "apps/gateway/src/server.ts",
    pattern: /gateway@[0-9A-Za-z.+-]+\+\$\{CONTRACT_VERSION\}/,
    value: (version) => `gateway@${version}+\${CONTRACT_VERSION}`,
  },
  {
    file: "packages/adapters/hermes/src/manifest.ts",
    pattern: /adapterVersion: "[^"]+"/,
    value: (version) => `adapterVersion: "${version}"`,
  },
  {
    file: "packages/adapters/hermes/bridge/agent_butler_bridge/server.py",
    pattern: /BRIDGE_VERSION = "[^"]+"/,
    value: (version) => `BRIDGE_VERSION = "${version}"`,
  },
  {
    file: "packages/adapters/openclaw/src/manifest.ts",
    pattern: /adapterVersion: "[^"]+"/,
    value: (version) => `adapterVersion: "${version}"`,
  },
  {
    file: "README.md",
    pattern: /当前开发版本：`[^`]+`/,
    value: (version) => `当前开发版本：\`${version}\``,
  },
];
const semverPattern = /^(0|[1-9]\d*)$/;
const releasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readJson(file) {
  return JSON.parse(readFileSync(resolve(root, file), "utf8"));
}

function writeJson(file, value) {
  writeFileSync(resolve(root, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertVersion(version) {
  if (!releasePattern.test(version)) {
    throw new Error(`无效 SemVer: ${version}`);
  }
  for (const part of version.split(/[.+-]/).slice(0, 3)) {
    if (!semverPattern.test(part)) throw new Error(`无效 SemVer 数字段: ${version}`);
  }
}

function check() {
  const version = readJson("package.json").version;
  assertVersion(version);
  const mismatches = [];
  for (const file of packageFiles) {
    const actual = readJson(file).version;
    if (actual !== version) mismatches.push(`${file}: ${actual}`);
  }
  for (const manifestFile of [
    "packages/adapters/hermes/manifest.json",
    "packages/adapters/openclaw/manifest.json",
  ]) {
    const manifest = readJson(manifestFile);
    if (manifest.adapterVersion !== version) {
      mismatches.push(`${manifestFile}: ${manifest.adapterVersion}`);
    }
  }
  for (const item of sourceVersions) {
    const content = readFileSync(resolve(root, item.file), "utf8");
    if (!content.includes(item.value(version))) mismatches.push(`${item.file}: 运行时版本未同步`);
  }
  if (mismatches.length > 0) {
    throw new Error(`版本不一致，期望 ${version}:\n- ${mismatches.join("\n- ")}`);
  }
  console.log(`版本一致: ${version}`);
}

function setVersion(version) {
  assertVersion(version);
  for (const file of packageFiles) {
    const pkg = readJson(file);
    pkg.version = version;
    writeJson(file, pkg);
  }
  for (const manifestFile of [
    "packages/adapters/hermes/manifest.json",
    "packages/adapters/openclaw/manifest.json",
  ]) {
    const manifest = readJson(manifestFile);
    manifest.adapterVersion = version;
    writeJson(manifestFile, manifest);
  }
  for (const item of sourceVersions) {
    const file = resolve(root, item.file);
    const content = readFileSync(file, "utf8");
    if (!item.pattern.test(content)) throw new Error(`找不到版本标记: ${item.file}`);
    writeFileSync(file, content.replace(item.pattern, item.value(version)), "utf8");
  }
  console.log(`版本已更新为 ${version}`);
  check();
}

const [command = "check", version] = process.argv.slice(2);
if (command === "check") {
  check();
} else if (command === "set" && version !== undefined) {
  setVersion(version);
} else {
  console.error("用法: node scripts/version.mjs check | set <semver>");
  process.exitCode = 1;
}
