/**
 * 专职 Agent 模板库抽屉 (Agent Template Drawer)：
 * 1. 浏览预设专职 Agent 模板（代码架构师、行政秘书、数据分析师、专业翻译官、风控专员）；
 * 2. 一键从模板创建并落盘至 ~/.hermes/profiles/；
 * 3. 支持在群聊中一键勾选拉入或移出当前协同群聊。
 */
import { useEffect, useState } from "react";
import {
  App,
  Button,
  Card,
  Drawer,
  Empty,
  Flex,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  AppstoreAddOutlined,
  CheckCircleFilled,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import type { BotProfile } from "./imTypes.js";
import { loadJson, postJson } from "../../../lib/api.js";

const { Paragraph, Text } = Typography;

export interface BotTemplate {
  templateId: string;
  name: string;
  role: string;
  avatar: string;
  category: "engineering" | "operations" | "general" | "analysis";
  duties: string[];
  systemPrompt: string;
}

export interface IMBotTemplateDrawerProps {
  open: boolean;
  onClose: () => void;
  groupId?: string;
  currentMemberBotIds?: string[];
  availableBots?: BotProfile[];
  onToggleGroupMember?: (botId: string, join: boolean) => void;
  onBotCreated?: (newBot: BotProfile) => void;
}

const CATEGORY_MAP: Record<string, { label: string; color: string }> = {
  engineering: { label: "工程架构", color: "blue" },
  operations: { label: "行政协同", color: "purple" },
  analysis: { label: "数据透视", color: "cyan" },
  general: { label: "通用职能", color: "green" },
};

export function IMBotTemplateDrawer(props: IMBotTemplateDrawerProps) {
  const { message } = App.useApp();
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);

  const fetchTemplates = async () => {
    setLoading(true);
    const res = await loadJson<{ ok: boolean; templates: BotTemplate[] }>("/api/bots/templates", 5_000);
    if (res.ok && res.data?.templates) {
      setTemplates(res.data.templates);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (props.open) {
      void fetchTemplates();
    }
  }, [props.open]);

  const handleInstantiate = async (tpl: BotTemplate) => {
    setCreatingId(tpl.templateId);
    const res = await postJson(
      `/api/bots/templates/${encodeURIComponent(tpl.templateId)}/instantiate`,
      {},
      10_000,
    );
    setCreatingId(null);
    const data = res.data as { ok?: boolean; bot?: BotProfile } | null;
    if (res.ok && data?.bot) {
      message.success({ content: `已成功启用「${tpl.name}」并写入本地名册！`, key: "bot-create" });
      props.onBotCreated?.(data.bot);
      // 若在群聊上下文，默认顺便加入群聊
      if (props.groupId && props.onToggleGroupMember) {
        props.onToggleGroupMember(data.bot.id, true);
      }
    } else {
      message.error({ content: "启用失败，请查看网关控制台日志", key: "bot-create" });
    }
  };

  const installedBotIds = new Set((props.availableBots || []).map((b) => b.id));
  const groupBotIds = new Set(props.currentMemberBotIds || []);

  return (
    <Drawer
      title={
        <Flex align="center" gap={8}>
          <AppstoreAddOutlined style={{ color: "var(--ant-color-primary)" }} />
          <span>专职 Agent 模板库</span>
        </Flex>
      }
      open={props.open}
      onClose={props.onClose}
      width={520}
      extra={
        <Button size="small" icon={<ReloadOutlined spin={loading} />} onClick={() => void fetchTemplates()}>
          刷新模板
        </Button>
      }
    >
      <Flex vertical gap={16}>
        <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
          自由扩展您的专家智能体。点击启用即可自动同步落盘至 <Text code>~/.hermes/profiles/</Text>，并在协同群聊中支持智能调度或 <Text code>@指定</Text> 接力。
        </Paragraph>

        {templates.length === 0 && !loading && (
          <Empty description="暂无可用模板" />
        )}

        {templates.map((tpl) => {
          const isInstalled = installedBotIds.has(tpl.templateId);
          const isInGroup = groupBotIds.has(tpl.templateId);
          const cat = CATEGORY_MAP[tpl.category] || { label: "专职角色", color: "default" };

          return (
            <Card
              key={tpl.templateId}
              size="small"
              style={{
                borderRadius: 10,
                border: isInstalled
                  ? "1px solid var(--ant-color-primary-border)"
                  : "1px solid var(--ant-color-border-secondary)",
                boxShadow: isInstalled ? "0 2px 8px rgba(22, 119, 255, 0.06)" : undefined,
              }}
            >
              <Flex vertical gap={12}>
                <Flex justify="space-between" align="flex-start">
                  <Flex align="center" gap={10}>
                    <div
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: 8,
                        background: "var(--ant-color-fill-secondary)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 20,
                      }}
                    >
                      {tpl.avatar || <RobotOutlined style={{ fontSize: 20, color: "var(--ant-color-text-secondary)" }} />}
                    </div>
                    <div>
                      <Flex align="center" gap={8}>
                        <Text strong style={{ fontSize: 14 }}>
                          {tpl.name}
                        </Text>
                        <Tag color={cat.color} style={{ margin: 0, fontSize: 11 }}>
                          {cat.label}
                        </Tag>
                        {isInstalled && (
                          <Tag color="success" icon={<CheckCircleFilled />} style={{ margin: 0 }}>
                            已在名册
                          </Tag>
                        )}
                      </Flex>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {tpl.role}
                      </Text>
                    </div>
                  </Flex>

                  {/* 操作区 */}
                  {!isInstalled ? (
                    <Button
                      type="primary"
                      size="small"
                      icon={<PlusOutlined />}
                      loading={creatingId === tpl.templateId}
                      onClick={() => void handleInstantiate(tpl)}
                    >
                      从模板启用
                    </Button>
                  ) : props.groupId ? (
                    <Flex align="center" gap={6}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        协同群
                      </Text>
                      <Switch
                        size="small"
                        checked={isInGroup}
                        onChange={(checked) => {
                          props.onToggleGroupMember?.(tpl.templateId, checked);
                        }}
                      />
                    </Flex>
                  ) : null}
                </Flex>

                <div
                  style={{
                    background: "var(--ant-color-fill-quaternary)",
                    padding: "8px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                >
                  <Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>
                    专职职责：
                  </Text>
                  <ul style={{ margin: 0, paddingLeft: 16, color: "var(--ant-color-text-secondary)" }}>
                    {tpl.duties.map((duty, idx) => (
                      <li key={idx}>{duty}</li>
                    ))}
                  </ul>
                </div>
              </Flex>
            </Card>
          );
        })}
      </Flex>
    </Drawer>
  );
}
