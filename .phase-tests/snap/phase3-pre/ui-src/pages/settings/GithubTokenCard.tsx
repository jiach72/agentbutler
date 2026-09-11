/**
 * GitHub 访问令牌设置卡片（设置页「本机安全」）：密码框输入 + 保存/清除 +
 * 配置状态徽标。令牌只写不读——状态来自 GET /api/github-token 的 configured
 * 布尔，任何接口都不回显令牌值；保存后立即生效（版本查询与技能市场即时使用）。
 */
import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Flex, Input, Popconfirm, Typography } from "antd";
import { loadJson, postJson } from "../../lib/api.js";
import { StatusBadge } from "../../components/StatusBadge.js";

const { Paragraph, Text } = Typography;

/** 与 watch 端校验一致：trim 后 8..200 字符。 */
const TOKEN_MIN_LENGTH = 8;
const TOKEN_MAX_LENGTH = 200;

/** 从错误响应体提取人话文案（watch 400 带 detail；代理 502/503 带 error）。 */
function extractError(data: unknown): string {
  if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record["detail"] === "string" && record["detail"] !== "") return record["detail"];
    if (typeof record["message"] === "string" && record["message"] !== "") return record["message"];
    if (record["error"] === "watch-unreachable") return "管家控制通道暂时不可达，请稍后重试。";
    if (typeof record["error"] === "string" && record["error"] !== "") return record["error"];
  }
  return "操作失败，请稍后重试或查看管家日志。";
}

export function GithubTokenCard() {
  const { message } = App.useApp();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  /** 查询配置状态；失败不弹错误（卡片内徽标降级为「状态未知」）。 */
  const loadStatus = useCallback(async () => {
    const result = await loadJson<{ configured: boolean }>("/api/github-token", 10_000);
    setConfigured(result.ok ? result.data.configured : null);
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const saveToken = async (): Promise<void> => {
    const trimmed = token.trim();
    if (trimmed.length < TOKEN_MIN_LENGTH || trimmed.length > TOKEN_MAX_LENGTH) {
      message.warning(`令牌长度需在 ${TOKEN_MIN_LENGTH}-${TOKEN_MAX_LENGTH} 字符之间（当前 ${trimmed.length}）。`);
      return;
    }
    if (busy) return;
    setBusy(true);
    const result = await postJson("/api/github-token", { token: trimmed }, 15_000);
    setBusy(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    setToken("");
    setConfigured(true);
    message.success("GitHub 访问令牌已保存，立即生效。");
  };

  const clearToken = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await postJson("/api/github-token", { clear: true }, 15_000);
    setBusy(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    setToken("");
    setConfigured(false);
    message.success("已清除 GitHub 访问令牌。");
  };

  return (
    <Card
      size="small"
      title="GitHub 访问令牌"
      extra={
        configured === null ? (
          <StatusBadge tone="muted" label="状态未知" />
        ) : configured ? (
          <StatusBadge tone="ok" label="已配置" />
        ) : (
          <StatusBadge tone="muted" label="未配置" />
        )
      }
    >
      <Flex vertical gap={12}>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          用于查询 GitHub 版本与技能市场，避免 API 限流。保存后立即生效，不需要重启。
        </Paragraph>
        <Flex gap={8} wrap="wrap">
          <Input.Password
            style={{ flex: "1 1 280px", minWidth: 240, maxWidth: 480 }}
            placeholder="ghp_… 或 github_pat_…"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onPressEnter={() => void saveToken()}
          />
          <Button type="primary" loading={busy} disabled={token.trim() === ""} onClick={() => void saveToken()}>
            保存
          </Button>
          <Popconfirm
            title="清除 GitHub 访问令牌？"
            description="清除后公开版本和技能查询可能再次受到匿名限流。"
            okText="确认清除"
            cancelText="保留"
            onConfirm={() => void clearToken()}
          >
            <Button danger disabled={!configured || busy}>清除</Button>
          </Popconfirm>
        </Flex>
        <Text type="secondary" style={{ fontSize: 12 }}>
          令牌以 0600 权限保存在管家数据目录，面板只显示是否已配置，不会回显内容。
        </Text>
      </Flex>
    </Card>
  );
}
