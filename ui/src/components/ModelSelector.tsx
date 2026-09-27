/**
 * 全局统一模型选择器 (ModelSelector)：
 * 为系统主模型、记忆探针、记忆库与受管任务提供统一直接点选能力。
 * 支持清晰的「本地免成本 (Ollama)」与「云端商业 API (按量计费)」分组与状态标识。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Divider, Empty, Flex, Select, Space, Tag, Typography } from "antd";
import {
  CheckCircleFilled,
  CloudOutlined,
  DesktopOutlined,
  PlusOutlined,
  ThunderboltFilled,
} from "@ant-design/icons";
import { Link } from "react-router-dom";
import type { UnifiedModelOption } from "@butler/contract";
import { loadJson } from "../lib/api.js";

const { Text } = Typography;

export interface ModelSelectorProps {
  value?: string;
  onChange?: (value: string, option?: UnifiedModelOption) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  filterCategory?: "all" | "local" | "cloud";
  filterFreeOnly?: boolean;
  /** 仅展示可对话/抽取模型（过滤掉纯向量嵌入模型，如 nomic-embed-text），默认 true */
  filterChatOnly?: boolean;
  disabled?: boolean;
  size?: "small" | "middle" | "large";
  showManageLinks?: boolean;
  options?: UnifiedModelOption[];
  onLoaded?: (options: UnifiedModelOption[]) => void;
}

export function ModelSelector({
  value,
  onChange,
  placeholder = "选择已配置的 API 或本地模型...",
  style,
  filterCategory = "all",
  filterFreeOnly = false,
  filterChatOnly = true,
  disabled = false,
  size = "middle",
  showManageLinks = true,
  options: externalOptions,
  onLoaded,
}: ModelSelectorProps) {
  const [internalOptions, setInternalOptions] = useState<UnifiedModelOption[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchOptions = useCallback(async () => {
    if (externalOptions) return;
    setLoading(true);
    try {
      const res = await loadJson<{ ok: boolean; options: UnifiedModelOption[] }>(
        "/api/models/unified-options",
        10_000,
      );
      if (res.ok && res.data.options) {
        setInternalOptions(res.data.options);
        onLoaded?.(res.data.options);
      }
    } catch {
      // 容错处理
    } finally {
      setLoading(false);
    }
  }, [externalOptions, onLoaded]);

  useEffect(() => {
    void fetchOptions();
  }, [fetchOptions]);

  const rawOptions = externalOptions ?? internalOptions;

  const filtered = useMemo(() => {
    return rawOptions.filter((opt) => {
      if (filterCategory === "local" && opt.category !== "local") return false;
      if (filterCategory === "cloud" && opt.category !== "cloud") return false;
      if (filterFreeOnly && opt.costCategory !== "free") return false;
      if (filterChatOnly && opt.isEmbedding === true) return false;
      return true;
    });
  }, [rawOptions, filterCategory, filterFreeOnly, filterChatOnly]);

  const localList = useMemo(() => filtered.filter((o) => o.category === "local"), [filtered]);
  const cloudList = useMemo(() => filtered.filter((o) => o.category === "cloud"), [filtered]);

  const selectOptions = useMemo(() => {
    const groups = [];

    if (localList.length > 0) {
      groups.push({
        label: (
          <Space size={6} style={{ color: "var(--ab-ok)", fontWeight: 600, fontSize: 12 }}>
            <DesktopOutlined />
            <span>本地免成本模型 (Ollama)</span>
            <Tag color="success" style={{ marginInlineStart: 4, fontSize: 10, padding: "0 4px" }}>
              0 API 成本
            </Tag>
          </Space>
        ),
        options: localList.map((opt) => ({
          value: opt.id,
          label: (
            <Flex justify="space-between" align="center" style={{ width: "100%" }}>
              <Space size={6}>
                <CheckCircleFilled style={{ color: "var(--ab-ok)", fontSize: 13 }} />
                <Text strong style={{ fontSize: 13 }}>
                  {opt.model}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ({opt.provider})
                </Text>
              </Space>
              <Tag color="success" bordered={false} style={{ fontSize: 11, padding: "0 6px" }}>
                本地免成本
              </Tag>
            </Flex>
          ),
          modelOption: opt,
        })),
      });
    }

    if (cloudList.length > 0) {
      groups.push({
        label: (
          <Space size={6} style={{ color: "var(--ant-color-primary)", fontWeight: 600, fontSize: 12 }}>
            <CloudOutlined />
            <span>云端商业 API 模型</span>
            <Tag color="blue" style={{ marginInlineStart: 4, fontSize: 10, padding: "0 4px" }}>
              按量计费
            </Tag>
          </Space>
        ),
        options: cloudList.map((opt) => ({
          value: opt.id,
          label: (
            <Flex justify="space-between" align="center" style={{ width: "100%" }}>
              <Space size={6}>
                <ThunderboltFilled style={{ color: opt.costCategory === "low" ? "var(--ab-ok)" : "var(--ant-color-primary)", fontSize: 13 }} />
                <Text strong style={{ fontSize: 13 }}>
                  {opt.model}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ({opt.name})
                </Text>
              </Space>
              <Space size={4}>
                {opt.costCategory === "low" && (
                  <Tag color="green" bordered={false} style={{ fontSize: 11, padding: "0 4px" }}>
                    高性价比
                  </Tag>
                )}
                {opt.probeStatus === "pass" ? (
                  <Tag color="cyan" bordered={false} style={{ fontSize: 11, padding: "0 4px" }}>
                    已连通
                  </Tag>
                ) : (
                  <Tag style={{ fontSize: 11, padding: "0 4px" }}>已存凭据</Tag>
                )}
              </Space>
            </Flex>
          ),
          modelOption: opt,
        })),
      });
    }

    return groups;
  }, [localList, cloudList]);

  // 匹配选中的 option
  const selectedOption = useMemo(() => {
    if (!value) return undefined;
    return rawOptions.find((o) => o.id === value || o.model === value);
  }, [value, rawOptions]);

  const handleChange = (val: string) => {
    const matched = rawOptions.find((o) => o.id === val);
    onChange?.(val, matched);
  };

  return (
    <Select
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
      loading={loading}
      disabled={disabled}
      size={size}
      style={{ minWidth: 280, ...style }}
      options={selectOptions}
      notFoundContent={
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无可直接选用的模型或 API Key"
        >
          <Space>
            <Link to="/settings?tab=llm">前往录入 API Key</Link>
            <Divider type="vertical" />
            <Link to="/settings?tab=llm&section=ollama">下载本地模型</Link>
          </Space>
        </Empty>
      }
      popupRender={(menu) => (
        <div>
          {menu}
          {showManageLinks && (
            <>
              <Divider style={{ margin: "6px 0" }} />
              <Flex justify="space-between" align="center" style={{ padding: "4px 12px" }}>
                <Link
                  to="/settings?tab=llm&section=ollama"
                  style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  <PlusOutlined />
                  下载本地模型 (免成本)
                </Link>
                <Link
                  to="/settings?tab=llm"
                  style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  <PlusOutlined />
                  添加商业 API Key
                </Link>
              </Flex>
            </>
          )}
        </div>
      )}
    />
  );
}
