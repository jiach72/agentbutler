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
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSupportedNodeVersion } from "./hermes-control-bridge.mjs";

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
if (gitVersion === null) {
  warn("git 可用", "git 命令不存在（不影响已部署实例运行，但自升级通道需要它）", "安装 git 后重试");
} else {
  pass("git 可用", gitVersion);
}

/* Node.js 运行时版本校验（需 >= 22.5.0 以满足 node:sqlite 及现代内置能力） */
const nodeVer = process.version;
const nodeOk = isSupportedNodeVersion(nodeVer);
if (nodeOk) {
  pass("Node.js 运行时", `${nodeVer}（${process.execPath}，满足 >= 22.5.0 要求）`);
} else {
  fail(
    "Node.js 运行时",
    `当前 Node 版本 ${nodeVer} 过低（路径：${process.execPath}）`,
    "升级 Node.js 到 >= 22.5.0（推荐使用 nvm 或从官方安装），以支持内置 node:sqlite 数据库与控制桥服务",
  );
}

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
if (webUp) pass("Web 端口可访问", `${webBase}（TCP ${webHost}:${webPort}）`);
else fail(
  "Web 端口可访问",
  `${webHost}:${webPort} 没有服务监听（浏览器打不开面板就是它）`,
  "容器场景：docker compose ps 看 butler-web 是否 healthy；WSL 场景：管理员 PowerShell 执行 scripts/fix-portproxy.ps1 修复 portproxy",
);

const gatewayUp = await probeTcp(webHost, 7532);
if (gatewayUp) pass("Gateway 端口可访问（7532）");
else warn("Gateway 端口可访问（7532）", "7532 未监听——通知与消息通道不可用", "docker compose logs --tail=100 butler-gateway 定位");

const watchUp = await probeTcp(webHost, 7533);
if (watchUp) pass("Watch 端口可访问（7533）");
else warn("Watch 端口可访问（7533）", "7533 未监听——采集与信任层不可用", "docker compose logs --tail=100 butler-watch 定位");

/* --------------------------- 3. Web /api/health --------------------------- */

if (webUp) {
  try {
    const res = await fetch(`${webBase.replace(/\/+$/, "")}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const gatewayFlag = body?.gateway === true || body?.services?.gateway === true;
      if (gatewayFlag === false) {
        warn("Web → Gateway 联通", "/api/health 返回 gateway:false（面板能开，但告警/通知链路断着）", "确认 butler-gateway 容器健康且 BUTLER_GATEWAY_URL 指向正确");
      } else {
        pass("Web /api/health", `HTTP ${res.status}，gateway 联通`);
      }
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
    "Hermes 消息桥链路 (8754/8755)",
    bridgeDirect ? "8754 直连可达" : "8755 转发器可达（8754 经转发）",
  );
} else {
  warn(
    "Hermes 消息桥链路 (8754/8755)",
    "8754/8755 均不可达——若你未启用消息网关（Hermes 消息面）可忽略本项",
    "启用消息面时：宿主先启动 hermes-gateway；容器内配置 BUTLER_HERMES_BRIDGE_URL=http://host.docker.internal:8755",
  );
}

const defaultHermesHome = join(process.env.HOME || homedir() || "", ".hermes");
const bridgeServerPath = join(defaultHermesHome, "hermes-agent", "gateway", "butler_bridge", "server.py");
// 本次部署自带的 Bridge 源码 = 版本基准。用它比对宿主副本，而不是只判断「文件在不在」：
// 宿主 `hermes update` 的 autostash 会把未跟踪的托管包整体搬走（留下空目录/缺 server.py），
// 而副本落后于当前版本时同样会让本机缺能力却毫无提示（#36 / #24）。
const repoBridgeServerPath = join(
  import.meta.dirname,
  "..",
  "packages",
  "adapters",
  "hermes",
  "bridge",
  "agent_butler_bridge",
  "server.py",
);
const readBridgeVersion = (path) => {
  try {
    const match = /BRIDGE_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(path, "utf8"));
    return match ? match[1] : "";
  } catch {
    return "";
  }
};
const bridgeInstallFix =
  "宿主执行：cd <repo>/packages/adapters/hermes/bridge && PYTHONPATH=. <宿主 Hermes venv 的 python> -m agent_butler_bridge.installer install ~/.hermes/hermes-agent，然后 hermes gateway restart（副本运行在网关进程内，必须重启才生效）";

if (existsSync(bridgeServerPath)) {
  try {
    const installedContent = readFileSync(bridgeServerPath, "utf8");
    const hasResolve = installedContent.includes("resolve_unknown") && installedContent.includes("/resolve");
    const hostVersion = readBridgeVersion(bridgeServerPath);
    const repoVersion = readBridgeVersion(repoBridgeServerPath);
    const versionNote =
      hostVersion === ""
        ? ""
        : `（宿主 ${hostVersion}${repoVersion === "" ? "" : ` / 本次部署 ${repoVersion}`}）`;
    if (hostVersion !== "" && repoVersion !== "" && hostVersion !== repoVersion) {
      warn(
        "Hermes 消息桥副本版本",
        `宿主 Bridge 副本与本次部署不同代${versionNote}${hasResolve ? "" : "，且缺少 resolve 权威结案端点"}`,
        bridgeInstallFix.replace("installer install", "installer update"),
      );
    } else if (!hasResolve) {
      warn(
        "Hermes 消息桥副本版本",
        `宿主已安装的 Bridge 副本缺少 resolve 权威结案端点（旧版本）${versionNote}`,
        "执行 python -m agent_butler_bridge.installer update ~/.hermes/hermes-agent 同步最新代码并重启 hermes-gateway",
      );
    } else {
      pass("Hermes 消息桥副本版本", `宿主 Bridge 副本具备 resolve 结案能力${versionNote}`);
    }
  } catch (err) {
    warn("Hermes 消息桥副本版本", `读取检查失败：${err.message}`);
  }
} else {
  warn(
    "Hermes 消息桥副本版本",
    `未找到宿主 Bridge 副本（${bridgeServerPath}）—— 宿主消息面不可用；若面板仍显示正常，即为静默降级`,
    bridgeInstallFix,
  );
}

/* ------------------ 4b. Hermes Host Control Bridge ------------------ */

const controlDirect = await probeTcp("127.0.0.1", 8756);
const controlForward = await probeTcp("127.0.0.1", 8757);
const controlTokenPath = join(defaultHermesHome, "agent-butler", "control.token");

if (controlDirect || controlForward) {
  pass(
    "Hermes 控制桥链路 (8756/8757)",
    controlDirect ? "8756 直连可达（宿主控制桥）" : "8757 转发器可达（WSL 转发模式）",
  );

  if (existsSync(controlTokenPath)) {
    try {
      const stats = statSync(controlTokenPath);
      const mode = (stats.mode & 0o777).toString(8);
      if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
        warn(
          "control.token 权限",
          `文件权限为 ${mode}（非 600，过于宽松）`,
          `执行 chmod 600 "${controlTokenPath}" 锁定权限`,
        );
      } else {
        pass("control.token 权限", "权限正常（600）");
      }

      // 探 /v1/health
      const token = readFileSync(controlTokenPath, "utf8").trim();
      const port = controlDirect ? 8756 : 8757;
      try {
        const healthRes = await fetch(`http://127.0.0.1:${port}/v1/health`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(4000),
        });
        if (healthRes.ok) {
          const healthData = await healthRes.json().catch(() => ({}));
          pass("控制桥健康状态", `版本 ${healthData.bridgeVersion || "ok"}，主管器 ${healthData.supervisor || "n/a"}，cron能力 ${healthData.cronCapable ? "具备" : "缺失"}`);
        } else if (healthRes.status === 401) {
          fail("控制桥健康状态", "401 Unauthorized：control.token 与控制桥不匹配", "重新执行 bash scripts/install-hermes-control-bridge.sh");
        }
      } catch (err) {
        // 健康检查端点失败不阻断 doctor 主流程
        void err;
      }
    } catch (e) {
      warn("control.token 读取", e.message);
    }
  } else {
    warn(
      "control.token 存在性",
      `${controlTokenPath} 不存在`,
      "执行 bash scripts/install-hermes-control-bridge.sh 自动生成 token 并安装控制桥",
    );
  }
} else {
  warn(
    "Hermes 控制桥链路 (8756/8757)",
    "8756/8757 均不可达——若未启用「定时任务」新功能可忽略本项",
    "执行 bash scripts/install-hermes-control-bridge.sh 安装宿主控制桥（Linux / macOS）",
  );
}

/* ------------------ 4c. Hermes API Server (Optional) ------------------ */

const envApiPortStr = process.env.BUTLER_HERMES_API_PORT?.trim();
const parsedApiPort = Number(envApiPortStr);
if (envApiPortStr && Number.isInteger(parsedApiPort) && parsedApiPort > 0) {
  const apiUp = await probeTcp("127.0.0.1", parsedApiPort);
  if (apiUp) {
    pass(`Hermes API Server 可选探针 (${parsedApiPort})`, "端口可达");
  } else {
    warn(
      `Hermes API Server 可选探针 (${parsedApiPort})`,
      `端口 ${parsedApiPort} 不可达；若未在 ~/.hermes/config.yaml 启用 api_server 平台可忽略本项，不影响消息与控制通道`,
      `如需启用该探针，请在 ~/.hermes/config.yaml 增加 gateway.platforms.api_server.extra 配置`,
    );
  }
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
  if (masterKey === "") {
    fail("主密钥已配置", ".env 缺 BUTLER_SECRET_MASTER_KEY（模型 API Key 将无法加密存储）", "重新执行 bash scripts/deploy.sh 会自动生成并写入；切勿手动轮换已有密钥");
  } else {
    pass("主密钥已配置", "已设置（值不显示）");
  }

  const publishHost = get("BUTLER_WEB_PUBLISH_HOST");
  const accessToken = get("BUTLER_ACCESS_TOKEN");
  const allowInsecure = get("BUTLER_ALLOW_INSECURE_PUBLIC");
  if (publishHost !== "" && publishHost !== "127.0.0.1" && accessToken === "") {
    if (allowInsecure === "1") {
      warn("Web 暴露策略", `BUTLER_WEB_PUBLISH_HOST=${publishHost} 且未配置访问口令（已通过 BUTLER_ALLOW_INSECURE_PUBLIC=1 放行）`, "同一网络设备可免口令直达面板");
    } else {
      fail(
        "公网暴露配套口令",
        `BUTLER_WEB_PUBLISH_HOST=${publishHost} 但未设置 BUTLER_ACCESS_TOKEN——端口一旦可达，任何人都能打开你的面板`,
        "生成强随机口令填入 BUTLER_ACCESS_TOKEN，或改回 BUTLER_WEB_PUBLISH_HOST=127.0.0.1",
      );
    }
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
