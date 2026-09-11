#!/usr/bin/env node
/**
 * 安装医生（M4.2）：doctor 一键体检命令。
 *
 * 目标：新用户从 clone 到首屏成功 ≤ 15 分钟，失败路径每一步都有下一步指引。
 *
 * 检查项（全部只读，不修任何东西——发现问题时给「一键复制修复命令」而不是自动改）：
 *   1. 运行环境（docker / compose v2 / git）
 *   2. 核心端口（7531 web / 7532 gateway / 7533 watch）是否可访问
 *   3. Web /api/health（gateway 联通性）
 *   4. Hermes Bridge 链路（8754/8755，配置了才有意义）
 *   5. 常见坑位自检（.env 关键项：主密钥存在性（只看有无，绝不打印）、公网暴露是否配套口令）
 *
 * 用法：node scripts/doctor.mjs [--web http://127.0.0.1:7531]
 * 退出码：0 = 全绿；1 = 有失败项。输出可整段复制给支持渠道（已脱敏）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const webIndex = argv.indexOf("--web");
const webBase = webIndex >= 0 ? argv[webIndex + 1] : "http://127.0.0.1:7531";

/** 三态结论：pass / warn（能用但要注意）/ fail（需要动手）。 */
const results = [];
const pass = (name, note = "") => results.push({ name, status: "pass", note });
const warn = (name, note, fix) => results.push({ name, status: "warn", note, fix });
const fail = (name, note, fix) => results.push({ name, status: "fail", note, fix });

/* ------------------------------ 1. 运行环境 ------------------------------ */

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
  return r.status === 0 && r.stdout ? r.stdout.trim() : null;
}

const dockerVersion = run("docker", ["--version"]);
if (dockerVersion === null) {
  fail("docker 可用", "docker 命令不存在或不可执行", "安装 Docker Desktop（Windows/macOS）或 docker-ce（Linux）后重试");
} else {
  const compose = run("docker", ["compose", "version"]);
  if (compose === null) {
    fail("docker compose v2", "检测到 docker 但没有 compose v2 子命令", "升级到 Docker 20.10+（自带 compose v2）；不要安装独立的 docker-compose v1");
  } else {
    pass("docker / compose v2", `${dockerVersion}；${compose.split("\n")[0]}`);
  }
}

const gitVersion = run("git", ["--version"]);
gitVersion === null
  ? warn("git 可用", "git 命令不存在（不影响已部署实例运行，但自升级通道需要它）", "安装 git 后重试")
  : pass("git 可用", gitVersion);

/* ------------------------------ 2. 核心端口 ------------------------------ */

async function probeTcp(host, port, timeoutMs = 2000) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

const webHost = new URL(webBase).hostname;
const webPort = Number(new URL(webBase).port || 7531);
const webUp = await probeTcp(webHost, webPort);
webUp ? pass("Web 端口可访问", `${webBase}（TCP ${webHost}:${webPort}）`) : fail(
  "Web 端口可访问",
  `${webHost}:${webPort} 没有服务监听（浏览器打不开面板就是它）`,
  "容器场景：docker compose ps 看 butler-web 是否 healthy；WSL 场景：管理员 PowerShell 执行 scripts/fix-portproxy.ps1 修复 portproxy",
);

const gatewayUp = await probeTcp(webHost, 7532);
gatewayUp ? pass("Gateway 端口可访问（7532）") : warn("Gateway 端口可访问（7532）", "7532 未监听——通知与消息通道不可用", "docker compose logs --tail=100 butler-gateway 定位");

const watchUp = await probeTcp(webHost, 7533);
watchUp ? pass("Watch 端口可访问（7533）") : warn("Watch 端口可访问（7533）", "7533 未监听——采集与信任层不可用", "docker compose logs --tail=100 butler-watch 定位");

/* --------------------------- 3. Web /api/health --------------------------- */

if (webUp) {
  try {
    const res = await fetch(`${webBase.replace(/\/+$/, "")}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const gatewayFlag = body?.gateway === true || body?.services?.gateway === true;
      gatewayFlag === false
        ? warn("Web → Gateway 联通", "/api/health 返回 gateway:false（面板能开，但告警/通知链路断着）", "确认 butler-gateway 容器健康且 BUTLER_GATEWAY_URL 指向正确")
        : pass("Web /api/health", `HTTP ${res.status}，gateway 联通`);
    } else {
      fail("Web /api/health", `HTTP ${res.status}`, "docker compose logs --tail=100 butler-web 查看错误栈");
    }
  } catch (error) {
    fail("Web /api/health", `请求失败：${error.message}`, "确认服务已启动且地址正确（--web 可覆盖）");
  }
}

/* --------------------------- 4. Hermes Bridge --------------------------- */

const bridgeDirect = await probeTcp("127.0.0.1", 8754);
const bridgeForward = await probeTcp("127.0.0.1", 8755);
if (bridgeDirect || bridgeForward) {
  pass(
    "Hermes Bridge 链路",
    bridgeDirect ? "8754 直连可达" : "8755 转发器可达（8754 经转发）",
  );
} else {
  warn(
    "Hermes Bridge 链路",
    "8754/8755 均不可达——若你未启用消息网关（Hermes 消息面）可忽略本项",
    "启用消息面时：宿主先启动 hermes-gateway；容器内配置 BUTLER_HERMES_BRIDGE_URL=http://host.docker.internal:8755",
  );
}

/* ------------------------------ 5. 配置自检 ------------------------------ */

const envPath = join(process.cwd(), ".env");
if (!existsSync(envPath)) {
  warn(".env 存在", "仓库根目录没有 .env（将使用全部默认值，Web 只监听本机）", "cp .env.example .env 后按注释填写");
} else {
  const env = readFileSync(envPath, "utf8");
  const get = (key) => {
    const m = new RegExp(`^${key}=(.*)$`, "m").exec(env);
    return m ? m[1].trim() : "";
  };

  const masterKey = get("BUTLER_SECRET_MASTER_KEY");
  masterKey === ""
    ? fail("主密钥已配置", ".env 缺 BUTLER_SECRET_MASTER_KEY（模型 API Key 将无法加密存储）", "重新执行 bash scripts/deploy.sh 会自动生成并写入；切勿手动轮换已有密钥")
    : pass("主密钥已配置", "已设置（值不显示）");

  const publishHost = get("BUTLER_WEB_PUBLISH_HOST");
  const accessToken = get("BUTLER_ACCESS_TOKEN");
  if (publishHost !== "" && publishHost !== "127.0.0.1" && accessToken === "") {
    fail(
      "公网暴露配套口令",
      `BUTLER_WEB_PUBLISH_HOST=${publishHost} 但未设置 BUTLER_ACCESS_TOKEN——端口一旦可达，任何人都能打开你的面板`,
      "生成强随机口令填入 BUTLER_ACCESS_TOKEN，或改回 BUTLER_WEB_PUBLISH_HOST=127.0.0.1",
    );
  } else {
    pass("Web 暴露策略安全", publishHost === "" || publishHost === "127.0.0.1" ? "仅本机可访问" : "非回环发布且已配置访问口令");
  }

  const hermesPath = get("BUTLER_HERMES_HOST_PATH");
  if (hermesPath !== "" && !existsSync(hermesPath)) {
    warn("Hermes 挂载路径存在", `BUTLER_HERMES_HOST_PATH=${hermesPath} 在本机不存在（若目标机与执行机不同可忽略）`, "确认路径包含 agent-butler/bridge.token");
  }
}

/* ------------------------------ 汇总输出 ------------------------------ */

const ICON = { pass: "✓", warn: "!", fail: "×" };
const LABEL = { pass: "通过", warn: "注意", fail: "失败" };
console.log("\n=== Agent Butler 安装医生（doctor）===\n");
for (const item of results) {
  console.log(`[${ICON[item.status]}] ${item.name} —— ${LABEL[item.status]}`);
  if (item.note) console.log(`     ${item.note}`);
  if (item.fix) console.log(`     下一步：${item.fix}`);
}
const fails = results.filter((item) => item.status === "fail").length;
const warns = results.filter((item) => item.status === "warn").length;
console.log(`\n结论：${fails} 项失败 / ${warns} 项注意 / ${results.length} 项检查`);
console.log(fails === 0 ? "核心链路健康。注意项不影响主流程使用。\n" : "请按「下一步」逐项处理后重跑本命令。\n");
process.exit(fails > 0 ? 1 : 0);
