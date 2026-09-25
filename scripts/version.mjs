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
    file: "apps/watch/src/http-common.ts",
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
    file: "scripts/hermes-control-bridge.mjs",
    pattern: /return "(?:0\.1\.0-beta|0\.1-beta|[0-9]+(?:\.[0-9]+)*)[0-9A-Za-z.+-]*";/,
    value: (version) => `return "${version}";`,
  },
  {
    file: "README.md",
    pattern: /当前(?:开发)?版本：`(?:0\.1\.0-beta|0\.1-beta|[0-9]+(?:\.[0-9]+)*)[0-9A-Za-z.+-]*`/,
    value: (version) => `当前版本：\`${displayVersion(version)}\``,
  },
];
const semverPattern = /^(0|[1-9]\d*)$/;
const releasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/**
 * 历史日期构建版本（0.1-beta 体系）：`0.1-beta.YYMMDD.HH`。
 * 1.0.0 及以后采用标准 SemVer。
 */
const dateBuildPattern = /^0\.1\.0-beta\.(\d{6})\.(\d{1,3})$/;

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
  // 日期构建段约束：0.1-beta 体系约束
  const dateBuild = dateBuildPattern.exec(version);
  if (version.startsWith("0.1") && dateBuild === null && version.startsWith("0.1.0-beta.")) {
    throw new Error(`日期构建版本格式: 0.1.0-beta.YYMMDD.构建号（得到 ${version}）`);
  }
}

/** 显示形态：0.1.0-beta.260911.13 → 0.1-beta.260911.13；1.0.0 保持 1.0.0。 */
export function displayVersion(version) {
  if (version.startsWith("0.1.0-beta.")) {
    return version.replace(/^0\.1\.0-beta\./, "0.1-beta.");
  }
  return version;
}

/** 由当前版本生成下一版本（1.xx 递增 patch；0.1 体系生成日期构建）。 */
export function nextDateBuild(buildNumber) {
  const current = readJson("package.json").version;
  if (current.startsWith("0.1")) {
    const now = new Date();
    const yymmdd = `${String(now.getUTCFullYear()).slice(2)}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const build = buildNumber ?? Number(hh);
    return `0.1.0-beta.${yymmdd}.${build}`;
  }
  const parts = current.split("-")[0].split(".").map(Number);
  if (parts.length === 3) {
    const patch = buildNumber !== undefined ? buildNumber : (parts[2] + 1);
    return `${parts[0]}.${parts[1]}.${patch}`;
  }
  return current;
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
    if (item.file === "README.md") {
      const matchNew = content.includes(`当前版本：\`${displayVersion(version)}\``);
      const matchOld = content.includes(`当前开发版本：\`${displayVersion(version)}\``);
      if (!matchNew && !matchOld) mismatches.push(`${item.file}: 运行时版本未同步`);
    } else if (!content.includes(item.value(version))) {
      mismatches.push(`${item.file}: 运行时版本未同步`);
    }
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
} else if (command === "next") {
  // 生成下一个日期构建版本（可选参数：构建号，CI 传 run.number）。
  console.log(nextDateBuild(version !== undefined ? Number(version) : undefined));
} else {
  console.error("用法: node scripts/version.mjs check | set <semver> | next [buildNumber]");
  console.error("  check — 校验全仓版本一致");
  console.error("  set   — 设定版本（如 1.0.0 正式版，或 1.0.1 等 SemVer）");
  console.error("  next  — 生成下一版本号（1.xx 递增补丁号，或传入构建号）");
  process.exitCode = 1;
}
