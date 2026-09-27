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
  Input,
  Segmented,
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
  SearchOutlined,
} from "@ant-design/icons";
import { CopySnippetButton } from "../../../components/CopySnippetButton.js";
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
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

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

  const filteredTemplates = templates.filter((tpl) => {
    if (selectedCategory !== "all" && tpl.category !== selectedCategory) {
      return false;
    }
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      tpl.name.toLowerCase().includes(q) ||
      tpl.role.toLowerCase().includes(q) ||
      tpl.duties.some((d) => d.toLowerCase().includes(q))
    );
  });

  return (
    <Drawer
      title={
        <Flex align="center" gap={8}>
          <AppstoreAddOutlined style={{ color: "var(--ab-brand)" }} />
          <span>专职 Agent 模板库</span>
        </Flex>
      }
      open={props.open}
      onClose={props.onClose}
      width={520}
      styles={{ wrapper: { width: 520, maxWidth: "100%" } }}
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

        {/* 搜索与分类筛选控制栏 */}
        <Flex vertical gap={8}>
          <Input
            placeholder="搜索 Agent 专家名称、职能或职责..."
            prefix={<SearchOutlined style={{ color: "var(--ab-text-3)" }} />}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            allowClear
            size="middle"
          />
          <Segmented
            value={selectedCategory}
            onChange={(val) => setSelectedCategory(val as string)}
            block
            options={[
              { label: "全部", value: "all" },
              { label: "工程架构", value: "engineering" },
              { label: "行政协同", value: "operations" },
              { label: "数据透视", value: "analysis" },
              { label: "通用职能", value: "general" },
            ]}
          />
        </Flex>

        {templates.length === 0 && !loading && (
          <Empty description="暂无可用模板" />
        )}

        {templates.length > 0 && filteredTemplates.length === 0 && (
          <Empty description="未找到符合条件的 Agent 模板">
            <Button
              size="small"
              onClick={() => {
                setSearchQuery("");
                setSelectedCategory("all");
              }}
            >
              重置筛选
            </Button>
          </Empty>
        )}

        {filteredTemplates.map((tpl) => {
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
                  ? "1px solid color-mix(in srgb, var(--ab-brand) 30%, var(--ab-border))"
                  : "1px solid var(--ab-border)",
                boxShadow: isInstalled ? "0 2px 8px color-mix(in srgb, var(--ab-brand) 8%, transparent)" : undefined,
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
                        background: "var(--ab-surface-2)",
                        border: "1px solid var(--ab-border)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 20,
                      }}
                    >
                      {tpl.avatar || <RobotOutlined style={{ fontSize: 20, color: "var(--ab-text-2)" }} />}
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
                      <Flex align="center" gap={6} wrap="wrap">
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {tpl.role}
                        </Text>
                        <CopySnippetButton text={tpl.templateId} label={`#${tpl.templateId}`} />
                      </Flex>
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
                    background: "var(--ab-surface-2)",
                    border: "1px solid var(--ab-border)",
                    padding: "8px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                >
                  <Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>
                    专职职责：
                  </Text>
                  <ul style={{ margin: 0, paddingLeft: 16, color: "var(--ab-text-2)" }}>
                    {tpl.duties.map((duty, idx) => (
                      <li key={idx}>{duty}</li>
                    ))}
                  </ul>
                </div>

                {tpl.systemPrompt && (
                  <Flex justify="flex-end" align="center" gap={8}>
                    <CopySnippetButton text={tpl.systemPrompt} label="复制 Prompt 设定" />
                  </Flex>
                )}
              </Flex>
            </Card>
          );
        })}
      </Flex>
    </Drawer>
  );
}
