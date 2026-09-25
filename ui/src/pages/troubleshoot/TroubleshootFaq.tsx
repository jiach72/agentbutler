/**
 * 排查常见问题与避坑指南（FAQ & Troubleshooting Knowledge Base）
 *
 * 结合 AGENTS.md 与真实运维部署经验，沉淀 6 大生产级常见问题：
 * 1. Hermes Bridge 断连自愈
 * 2. WSL /mnt/c 构建与权限竞态
 * 3. 模型接口 401 密钥失效
 * 4. Windows WSL 7531 端口访问漂移
 * 5. SQLite-WAL 瞬态锁定自愈
 * 6. 通道配置变更应用超时
 */
import { useState, useMemo } from "react";
import { Input, Tag, Button, Flex, Typography, Collapse } from "antd";
import {
  SearchOutlined,
  QuestionCircleOutlined,
  RightOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ApiOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { CopySnippetButton } from "../../components/CopySnippetButton.js";
import type { SymptomId } from "./symptoms.js";

const { Paragraph } = Typography;

export interface FaqItem {
  id: string;
  category: "gateway" | "env" | "model" | "network" | "storage";
  categoryLabel: string;
  title: string;
  symptomTag: string;
  symptomId?: SymptomId;
  summary: string;
  rootCause: string;
  verificationSnippet?: string;
  fixSnippet?: string;
  solution: string;
  tags: string[];
}

const FAQ_ITEMS: readonly FaqItem[] = [
  {
    id: "bridge-offline",
    category: "gateway",
    categoryLabel: "消息网关",
    title: "Hermes Bridge 显示未连接或频繁重连？",
    symptomTag: "它不回我消息了",
    symptomId: "no-reply",
    summary: "部署后消息网关处于 connected: false 或在面板反复闪烁离线状态。",
    rootCause:
      "网关到 Hermes Bridge 的通信具备内建自愈机制：Bridge 短暂不可达时 Gateway 只标记离线而不崩溃退出，后台 reconcile 循环每秒自动重试；Bridge 恢复后自动重装策略并从上次 cursor 续传 Outbox。首次部署未连通通常为 Bridge Token 路径错位或宿主未放通回环转发。",
    verificationSnippet: "bash scripts/bridge-healthcheck.sh",
    fixSnippet: "systemctl --user restart hermes-gateway",
    solution:
      "优先运行健康检查脚本进行逐段探测（Token 存在性 → Bridge 监听 → 转发器 → Gateway 连通）。若提示 Bridge 异常，可在宿主机执行 systemctl --user restart hermes-gateway 重载网关。",
    tags: ["hermes", "bridge", "token", "离线", "自愈", "no-reply", "8754", "8755"],
  },
  {
    id: "wsl-eacces",
    category: "env",
    categoryLabel: "环境构建",
    title: "WSL 环境下执行 pnpm 或 docker build 报 EACCES 权限错误？",
    symptomTag: "它报错了",
    symptomId: "error",
    summary: "在 /mnt/c 目录下运行构建、依赖安装或容器卷挂载时出现无权限或文件锁冲突。",
    rootCause:
      "Windows 与 WSL 之间的 9P 跨文件系统协议在处理 node_modules 大量小文件并发读写、符号链接以及 Unix 权限属性时存在底层竞态，极易引发文件锁定与 EACCES 报错。",
    verificationSnippet: "pwd && df -T .",
    fixSnippet: "mkdir -p ~/agentbutler && cp -r . ~/agentbutler && cd ~/agentbutler",
    solution:
      "严禁在 /mnt/c 目录下进行构建与生产部署。必须将代码仓库完整克隆或迁移至 WSL 原生的 Linux ext4 文件系统（如用户主目录 ~/agentbutler），在纯 Linux 环境下运行 pnpm install 与 docker compose。",
    tags: ["wsl", "eacces", "mnt/c", "ext4", "权限", "构建", "pnpm"],
  },
  {
    id: "model-401",
    category: "model",
    categoryLabel: "模型服务",
    title: "模型探针与记忆写入整片失败，后台大量 401 报错？",
    symptomTag: "它报错了",
    symptomId: "error",
    summary: "调用大模型时频繁超时或报错 401 Unauthorized，无法生成回复与摘要。",
    rootCause:
      ".env 中的模型 API Key 填写有误、包含了多余首尾空格、或者中转端点地址协议格式不对。为保障凭证安全，系统不会在日志中打印真实 Key，若未经预检启动会导致管家持续带坏 Key 重试。",
    verificationSnippet: 'curl -s -H "Authorization: Bearer $BUTLER_MODEL_KEY" "$BUTLER_MODEL_ENDPOINT/models" | head -n 5',
    solution:
      "在宿主机使用上述最小 curl 命令直接打目标模型端点的 /models 或对应探针端点，确认返回 HTTP 200。确认有效后重新更新 .env 并重启管家容器。",
    tags: ["401", "api key", "模型", "unauthorized", "endpoint", "curl"],
  },
  {
    id: "wsl-portproxy",
    category: "network",
    categoryLabel: "网络访问",
    title: "容器状态均为 healthy，但 Windows 浏览器打不开 7531 端口？",
    symptomTag: "说不上来",
    symptomId: "not-sure",
    summary: "docker compose ps 显示 butler-web 正常运行，但访问 http://127.0.0.1:7531 连接被拒绝或超时。",
    rootCause:
      "WSL2 虚拟网卡在宿主机重启、休眠唤醒或 Wi-Fi 网络切换后，其分配的内网虚拟 IP 会发生漂移。此前通过 Windows netsh 设置的端口转发规则仍指向旧的 WSL IP，导致流量无法抵达容器。",
    fixSnippet: "powershell -ExecutionPolicy Bypass -File .\\scripts\\fix-portproxy.ps1",
    solution:
      "在 Windows 宿主机以管理员身份运行 PowerShell 执行 fix-portproxy.ps1 脚本，自动刷新端口映射绑定；或者在 %USERPROFILE%\\.wslconfig 中配置 [wsl2] networkingMode=mirrored 启用镜像网络模式彻底免去代理转换。",
    tags: ["portproxy", "7531", "wsl", "网络", "打不开", "连接拒绝", "mirrored"],
  },
  {
    id: "sqlite-busy",
    category: "storage",
    categoryLabel: "数据存储",
    title: "日志偶见 SQLITE_BUSY 或 database is locked 报警？",
    symptomTag: "它变慢了",
    symptomId: "slow",
    summary: "在日志流中看到偶发的 SQLite 锁冲突警告，但几秒后系统继续正常运转。",
    rootCause:
      "Agent Butler 底层数据层启用了 WAL（Write-Ahead Logging）高性能并发模式，写入路径设计了指数退避自动重试机制。偶发瞬态数据库锁属于高并发批处理时的正常排队现象，系统会自动重试并自愈，无需过早介入。",
    verificationSnippet: "docker compose logs --tail=100 butler-watch | grep -i sqlite",
    fixSnippet: "docker compose restart butler-watch",
    solution:
      "只要面板监控与任务数据仍在按秒持续更新，此告警可忽略。仅当锁错误持续数分钟且数据完全停更时，才执行重启 butler-watch 容器排空挂起的写入事务，并检查有无非常规的多进程文件直连。",
    tags: ["sqlite", "sqlite_busy", "database locked", "wal", "并发", "watch"],
  },
  {
    id: "channel-pending",
    category: "gateway",
    categoryLabel: "通道配置",
    title: "在面板修改消息通道后，状态一直卡在「应用中」？",
    symptomTag: "更新之后不对",
    symptomId: "after-update",
    summary: "点击开启/停用某渠道平台后，配置徽标长达 60 秒显示黄色应用中，未转为就绪。",
    rootCause:
      "通道控制通过热更新 ~/.hermes/config.yaml 的 platforms 白名单配置生效，并向 Hermes 网关发出优雅重启指令。若 Hermes 宿主守护进程由于依赖锁或环境异常未能按时重启完成，状态同步回调就会超时悬挂。",
    verificationSnippet: "journalctl --user -u hermes-gateway -n 30 --no-pager",
    fixSnippet: "systemctl --user restart hermes-gateway",
    solution:
      "使用 journalctl 查阅宿主网关日志确认加载报错。排查并修复 YAML 格式或 Token 授权后，手动重启一次宿主 hermes-gateway，网关检测到配置同步后会自动恢复「已生效」状态。",
    tags: ["channel", "通道", "应用中", "pending", "hermes-gateway", "yaml"],
  },
];

interface TroubleshootFaqProps {
  /** 用户点击「用向导排查」时的回调 */
  onSelectSymptom?: (symptomId: SymptomId) => void;
}

export function TroubleshootFaq({ onSelectSymptom }: TroubleshootFaqProps) {
  const [keyword, setKeyword] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  const filteredItems = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return FAQ_ITEMS.filter((item) => {
      const matchCat = selectedCategory === "all" || item.category === selectedCategory;
      if (!matchCat) return false;
      if (!kw) return true;
      return (
        item.title.toLowerCase().includes(kw) ||
        item.summary.toLowerCase().includes(kw) ||
        item.rootCause.toLowerCase().includes(kw) ||
        item.solution.toLowerCase().includes(kw) ||
        item.tags.some((t) => t.toLowerCase().includes(kw))
      );
    });
  }, [keyword, selectedCategory]);

  const categories = [
    { key: "all", label: "全部", icon: <QuestionCircleOutlined /> },
    { key: "gateway", label: "消息网关", icon: <ThunderboltOutlined /> },
    { key: "env", label: "环境构建", icon: <DesktopOutlined /> },
    { key: "model", label: "模型服务", icon: <ApiOutlined /> },
    { key: "storage", label: "数据存储", icon: <DatabaseOutlined /> },
    { key: "network", label: "网络访问", icon: <ToolOutlined /> },
  ];

  return (
    <section className="ts-faq-section" aria-labelledby="ts-faq-heading">
      <div className="ts-faq-header">
        <Flex justify="space-between" align="flex-start" wrap="wrap" gap={12}>
          <div>
            <Flex align="center" gap={8}>
              <QuestionCircleOutlined style={{ color: "var(--ab-primary)", fontSize: 18 }} />
              <h2 id="ts-faq-heading" className="ts-faq-title">
                常见问题与避坑指南
              </h2>
            </Flex>
            <p className="ts-faq-sub">
              源自生产实战的 6 大常见暗礁，包含根因本质、预检诊断命令与自愈机制。
            </p>
          </div>

          <div className="ts-faq-search-box">
            <Input
              prefix={<SearchOutlined style={{ color: "var(--ab-text-3)" }} />}
              placeholder="搜索问题、错误关键字（如 401、WSL、Bridge）..."
              allowClear
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ width: 280 }}
            />
          </div>
        </Flex>

        <div className="ts-faq-filters">
          <Flex gap={8} wrap="wrap">
            {categories.map((cat) => (
              <button
                key={cat.key}
                type="button"
                className={`ts-faq-filter-btn${selectedCategory === cat.key ? " is-active" : ""}`}
                onClick={() => setSelectedCategory(cat.key)}
              >
                {cat.icon}
                <span>{cat.label}</span>
              </button>
            ))}
          </Flex>
        </div>
      </div>

      {filteredItems.length === 0 ? (
        <div className="ts-faq-empty">
          <ExclamationCircleOutlined style={{ fontSize: 28, color: "var(--ab-text-3)" }} />
          <p>未找到匹配的问题或命令，请尝试更换关键词。</p>
        </div>
      ) : (
        <Collapse
          accordion
          ghost
          className="ts-faq-collapse"
          expandIconPlacement="end"
          items={filteredItems.map((item) => ({
            key: item.id,
            forceRender: true,
            label: (
              <div className="ts-faq-item-header">
                <Flex align="center" gap={10} wrap="wrap">
                  <Tag className="ts-faq-cat-tag">{item.categoryLabel}</Tag>
                  <span className="ts-faq-item-title">{item.title}</span>
                </Flex>
                <div className="ts-faq-item-summary">{item.summary}</div>
              </div>
            ),
            children: (
              <div className="ts-faq-body">
                <div className="ts-faq-block">
                  <div className="ts-faq-block-heading">
                    <CheckCircleOutlined style={{ color: "var(--ab-primary)" }} />
                    <span>根因本质与底层逻辑</span>
                  </div>
                  <Paragraph className="ts-faq-text">{item.rootCause}</Paragraph>
                </div>

                {item.verificationSnippet && (
                  <div className="ts-faq-block">
                    <div className="ts-faq-block-heading">
                      <SearchOutlined style={{ color: "var(--ab-text-2)" }} />
                      <span>诊断与预检命令</span>
                    </div>
                    <div className="ts-faq-code-box">
                      <code>{item.verificationSnippet}</code>
                      <CopySnippetButton text={item.verificationSnippet} />
                    </div>
                  </div>
                )}

                {item.fixSnippet && (
                  <div className="ts-faq-block">
                    <div className="ts-faq-block-heading">
                      <ThunderboltOutlined style={{ color: "var(--ab-warn)" }} />
                      <span>推荐修复命令</span>
                    </div>
                    <div className="ts-faq-code-box">
                      <code>{item.fixSnippet}</code>
                      <CopySnippetButton text={item.fixSnippet} />
                    </div>
                  </div>
                )}

                <div className="ts-faq-block">
                  <div className="ts-faq-block-heading">
                    <CheckCircleOutlined style={{ color: "var(--ab-ok)" }} />
                    <span>推荐处理步骤</span>
                  </div>
                  <Paragraph className="ts-faq-text">{item.solution}</Paragraph>
                </div>

                {item.symptomId && onSelectSymptom && (
                  <div className="ts-faq-footer-action">
                    <Button
                      type="link"
                      icon={<RightOutlined />}
                      onClick={() => onSelectSymptom(item.symptomId!)}
                      style={{ paddingLeft: 0, fontWeight: 500 }}
                    >
                      使用向导排查「{item.symptomTag}」现象
                    </Button>
                  </div>
                )}
              </div>
            ),
          }))}
        />
      )}
    </section>
  );
}
