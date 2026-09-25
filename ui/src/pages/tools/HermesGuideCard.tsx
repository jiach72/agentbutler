import { useState } from "react";
import { CopySnippetButton } from "../../components/CopySnippetButton.js";
import { EtherealIcon } from "../../components/EtherealIcon.js";

type CategoryKey = "service" | "bridge" | "config" | "cli";

interface CommandItem {
  cmd: string;
  desc: string;
  caveat?: string;
  tag?: string;
}

const CATEGORIES: { key: CategoryKey; label: string; icon: string }[] = [
  { key: "service", label: "服务状态与管理", icon: "schedule" },
  { key: "bridge", label: "网关与 Bridge 诊断", icon: "network_check" },
  { key: "config", label: "配置修改与预检", icon: "settings" },
  { key: "cli", label: "任务与常用 CLI", icon: "terminal" },
];

const COMMANDS: Record<CategoryKey, CommandItem[]> = {
  service: [
    {
      cmd: "systemctl --user status hermes-gateway",
      desc: "查看宿主机原生 Hermes 消息网关进程运行状态与监听端口",
      tag: "推荐常用",
    },
    {
      cmd: "systemctl --user restart hermes-gateway",
      desc: "在修改 ~/.hermes/config.yaml 或注入 Bridge 后，优雅重启网关进程加载最新配置",
      caveat: "配置修改后必须重启宿主网关，Bridge 才会重新加载策略并与 Butler 连接",
    },
    {
      cmd: "docker compose ps",
      desc: "检查 Butler 控制台各容器（gateway / watch / web）的健康探测 (Healthy) 状态",
    },
    {
      cmd: "docker compose logs -f --tail=100 butler-gateway",
      desc: "跟踪消息网关容器实时日志，排查 Bridge 握手与消息转发细节",
    },
  ],
  bridge: [
    {
      cmd: "bash scripts/bridge-healthcheck.sh",
      desc: "全链路健康诊断：依次探测 Token 存在性 → 宿主 8754 回环 → 转发器链路 → Gateway 状态",
      tag: "排障首选",
    },
    {
      cmd: "curl -s http://127.0.0.1:8754/healthz",
      desc: "直接向宿主 Hermes Bridge 发起回环健康探测，预期返回 200 OK",
      caveat: "Bridge 必须严格监听在 127.0.0.1 回环地址；改用 0.0.0.0 会触发代码自毁保护导致崩溃循环",
    },
    {
      cmd: "curl -s http://127.0.0.1:7531/api/messages/overview",
      desc: "读取 Butler 消息控制面数据总览，核实 Outbox 待发队列与连接自愈状态",
    },
  ],
  config: [
    {
      cmd: "nano ~/.hermes/config.yaml",
      desc: "编辑 Hermes 核心配置文件（通道白名单、模型连接参数与定时调度设定）",
      caveat: "编辑前请确保备份原文件；保存后执行 systemctl --user restart hermes-gateway",
    },
    {
      cmd: "ls -la ~/.hermes/agent-butler/bridge.token",
      desc: "确认 Butler 通信认证 Token 文件是否存在且具有只读权限",
      caveat: "若 Token 缺失，Gateway 容器将无法鉴权并通过自愈循环持续重试",
    },
    {
      cmd: 'curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $API_KEY" $API_BASE/models',
      desc: "大模型 API Key 连通性预检（应返回 200 OK，避免部署后探针批量 401 报错）",
      tag: "部署避坑",
    },
  ],
  cli: [
    {
      cmd: "hermes task list",
      desc: "列出当前 Hermes 调度器中登记的全部定时任务与下次执行时间",
    },
    {
      cmd: "hermes run <task_id>",
      desc: "手动触发执行指定的任务 ID，不等待定时 Cron 周期到达",
    },
    {
      cmd: "docker compose run --rm butler-updater",
      desc: "手动运行一次系统更新与数据库迁移检查",
    },
  ],
};

export function HermesGuideCard() {
  const [activeCategory, setActiveCategory] = useState<CategoryKey>("service");

  return (
    <div className="rounded-2xl bg-surface-container-lowest p-4 md:p-5 shadow-xs border border-outline-variant/15 space-y-4">
      {/* 头部标题与定位 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-surface-container">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary-soft flex items-center justify-center text-primary shrink-0">
            <EtherealIcon name="terminal" size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-on-surface tracking-tight m-0">Hermes 引擎指引与常用运维命令</h3>
              <span className="text-[11px] px-2 py-0.2 rounded-full bg-primary-soft text-primary font-mono font-medium">
                CLI CHEATSHEET
              </span>
            </div>
            <p className="text-xs text-on-surface-variant m-0 mt-0.5">
              宿主机原生网关、Bridge 回环通信与配置热重载速查手册
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 self-start sm:self-center px-2 py-1 rounded-full bg-surface-container text-xs font-mono text-on-surface-variant">
          <span className="w-1.5 h-1.5 rounded-full bg-ok" />
          <span>Bridge 127.0.0.1:8754 回环</span>
        </div>
      </div>

      {/* 分类选项卡 */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            type="button"
            onClick={() => setActiveCategory(cat.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              activeCategory === cat.key
                ? "bg-primary text-white shadow-xs"
                : "bg-surface-container hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface"
            }`}
          >
            <EtherealIcon name={cat.icon} size={13} className={activeCategory === cat.key ? "text-white" : ""} />
            <span>{cat.label}</span>
          </button>
        ))}
      </div>

      {/* 命令列表 */}
      <div className="space-y-3">
        {COMMANDS[activeCategory].map((item) => (
          <div
            key={item.cmd}
            className="p-3 rounded-xl bg-surface-container-low border border-outline-variant/10 space-y-2 hover:border-outline-variant/25 transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-medium text-on-surface truncate">{item.desc}</span>
                {item.tag && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-tertiary-container/10 text-tertiary shrink-0">
                    {item.tag}
                  </span>
                )}
              </div>
              <CopySnippetButton text={item.cmd} className="shrink-0" />
            </div>

            {/* 命令行展示框 */}
            <div className="px-3 py-2 rounded-lg bg-surface-container-high/80 border border-outline-variant/15 font-mono text-xs text-on-surface select-all overflow-x-auto">
              <code>{item.cmd}</code>
            </div>

              {item.caveat && (
                <div className="flex items-start gap-1.5 text-[11px] text-warn leading-tight">
                  <EtherealIcon name="warning" size={13} className="shrink-0 mt-0.5 text-warn" />
                  <span>{item.caveat}</span>
                </div>
              )}
          </div>
        ))}
      </div>
    </div>
  );
}
