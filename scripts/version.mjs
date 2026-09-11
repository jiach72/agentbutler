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
    // 接受显示形态（0.1-beta.x，规范）与存储形态（0.1.0-beta.x）任一写法。
    pattern: /当前开发版本：`(?:0\.1\.0-beta|0\.1-beta)[0-9A-Za-z.]*`/,
    value: (version) => `当前开发版本：\`${displayVersion(version)}\``,
  },
];
const semverPattern = /^(0|[1-9]\d*)$/;
const releasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/**
 * 日期构建版本：`0.1-beta.YYMMDD.HH`（SemVer 4 段在多数生态不合法， prerelease 部分段完全合法：
 * 0.1.0-beta.260911.13 —— 对外显示时去掉多余的 patch 0 写作 0.1-beta.YYMMDD.HH）。
 * 存储形态恒为合法 SemVer（npm/pnpm/compose tag 均可解析）；
 * `v` 前缀仅用于 git tag 与 CI 触发。
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
  // 日期构建段约束：YYMMDD 必须是 6 位、构建号 ≤3 位（CI run.number 注入）。
  const dateBuild = dateBuildPattern.exec(version);
  if (version.startsWith("0.1") && dateBuild === null && version.startsWith("0.1.0-beta.")) {
    throw new Error(`日期构建版本格式: 0.1.0-beta.YYMMDD.构建号（得到 ${version}）`);
  }
}

/** 显示形态：0.1.0-beta.260911.13 → 0.1-beta.260911.13（对外统一口径）。 */
export function displayVersion(version) {
  return version.replace(/^0\.1\.0-beta\./, "0.1-beta.");
}

/** 由当前 UTC 时间 + 构建号生成日期构建版本（本地缺省取当前小时）。 */
export function nextDateBuild(buildNumber) {
  const now = new Date();
  const yymmdd = `${String(now.getUTCFullYear()).slice(2)}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const build = buildNumber ?? Number(hh);
  return `0.1.0-beta.${yymmdd}.${build}`;
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
} else if (command === "next") {
  // 生成下一个日期构建版本（可选参数：构建号，CI 传 run.number）。
  console.log(nextDateBuild(version !== undefined ? Number(version) : undefined));
} else {
  console.error("用法: node scripts/version.mjs check | set <semver> | next [buildNumber]");
  console.error("  check — 校验全仓版本一致");
  console.error("  set   — 设定版本（日期构建形如 0.1.0-beta.260911.13，显示为 0.1-beta.260911.13）");
  console.error("  next  — 按当前 UTC 时间生成下一版本号；CI 传构建号");
  process.exitCode = 1;
}
