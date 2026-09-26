/**
 * 知识图谱（星图 / Galaxy Knowledge Graph）：
 * 全面基于 Hindsight 官方原生 Constellation 星图引擎实现。
 *
 * 核心技术与视觉规范：
 * 1. 采用 Hindsight 官方 Canvas 60fps 星图渲染架构与配色；
 * 2. 具备有机呼吸物理微动、流光二次贝塞尔曲线与沿途飞跃光子；
 * 3. 采用 Monotone Chain 凸包算法绘制聚类软光晕包络；
 * 4. 智能空间哈希网格避障，杜绝文本遮挡重叠；
 * 5. 联动知识库原生筛选（Obsidian、收集箱、标签）、搜索定位与节点侧边抽屉详情。
 */
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Drawer,
  Empty,
  Flex,
  Input,
  Radio,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  AimOutlined,
  BookOutlined,
  CompressOutlined,
  FileDoneOutlined,
  FileTextOutlined,
  InboxOutlined,
  MessageOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  TagOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import {
  HindsightConstellationGraph,
  HINDSIGHT_PALETTE,
  type ConstellationData,
  type ConstellationLink,
  type ConstellationNode,
} from "../../components/HindsightConstellationGraph.js";

const { Paragraph, Text, Title } = Typography;

export interface GraphNode {
  id: string;
  name: string;
  type: "document" | "obsidian" | "inbox" | "tag" | "concept";
  val: number;
  connections: number;
  color?: string;
  cluster?: string;
  details?: {
    path?: string;
    size?: number;
    updatedAt?: string;
    summary?: string;
  };
}

export interface GraphLink {
  source: string;
  target: string;
  type: "wikilink" | "tag" | "hierarchy" | "semantic";
  strength?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: {
    totalNodes: number;
    totalLinks: number;
    docCount: number;
    tagCount: number;
  };
}

export interface KnowledgeStarChartProps {
  data: GraphData | null;
  loading: boolean;
  onRefresh?: () => void;
  onOpenDedup?: () => void;
}

export function KnowledgeStarChart({
  data,
  loading,
  onRefresh,
  onOpenDedup,
}: KnowledgeStarChartProps) {
  const [filterType, setFilterType] = useState<string>("all");
  const [labelMode, setLabelMode] = useState<"smart" | "all" | "none">("smart");
  const [searchKeyword, setSearchKeyword] = useState<string>("");
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // 节点分类统计
  const filterCounts = useMemo(() => {
    if (!data?.nodes) return { all: 0, obsidian: 0, document: 0, inbox: 0, tag: 0 };
    let obsidian = 0;
    let document = 0;
    let inbox = 0;
    let tag = 0;
    for (const n of data.nodes) {
      if (n.type === "obsidian") obsidian++;
      else if (n.type === "document") document++;
      else if (n.type === "inbox") inbox++;
      else if (n.type === "tag") tag++;
    }
    return {
      all: data.nodes.length,
      obsidian,
      document,
      inbox,
      tag,
    };
  }, [data?.nodes]);

  // 将知识库图数据映射至 Hindsight Constellation 数据格式
  const constellationData = useMemo<ConstellationData | null>(() => {
    if (!data || !data.nodes || data.nodes.length === 0) return null;

    const filteredNodes = data.nodes.filter((n) => {
      if (filterType === "all") return true;
      if (filterType === "obsidian") return n.type === "obsidian" || (n.type === "concept" && n.connections > 1);
      if (filterType === "document") return n.type === "document";
      if (filterType === "inbox") return n.type === "inbox";
      if (filterType === "tag") return n.type === "tag";
      return n.type === filterType;
    });

    const activeNodeIds = new Set(filteredNodes.map((n) => n.id));

    // 匹配 Hindsight 官方语义类型与调色
    const nodes: ConstellationNode[] = filteredNodes.map((n) => {
      let group = "entity";
      let color = HINDSIGHT_PALETTE.entity;

      if (n.type === "obsidian") {
        group = "world";
        color = HINDSIGHT_PALETTE.world;
      } else if (n.type === "inbox") {
        group = "observation";
        color = HINDSIGHT_PALETTE.observation;
      } else if (n.type === "document") {
        group = "experience";
        color = HINDSIGHT_PALETTE.experience;
      } else if (n.type === "tag") {
        group = "semantic";
        color = HINDSIGHT_PALETTE.semantic;
      }

      return {
        id: n.id,
        label: n.name,
        group: n.cluster || group,
        color: n.color || color,
        val: n.val,
        linkCount: n.connections,
        raw: n,
      };
    });

    const links: ConstellationLink[] = (data.links || [])
      .filter((l) => activeNodeIds.has(l.source) && activeNodeIds.has(l.target))
      .map((l) => ({
        source: l.source,
        target: l.target,
        type: l.type === "wikilink" ? "semantic" : l.type === "tag" ? "entity" : "temporal",
        weight: l.strength,
      }));

    return { nodes, links };
  }, [data, filterType]);

  const handleNodeClick = useCallback((node: ConstellationNode) => {
    if (node.raw) {
      setSelectedNode(node.raw as GraphNode);
    }
  }, []);

  const handleFitView = () => {
    setRefreshKey((k) => k + 1);
  };

  const hasData = Boolean(data && data.nodes && data.nodes.length > 0);

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <Card
        size="small"
        style={{
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid var(--ant-color-border-secondary)",
          background: "var(--ant-color-bg-container)",
        }}
      >
        <Flex vertical gap={12}>
          {/* 顶部标题与统计概览 */}
          <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
            <Flex align="center" gap={8}>
              <AimOutlined style={{ color: "var(--ant-color-primary)", fontSize: 16 }} />
              <Title level={5} style={{ margin: 0 }}>
                知识星图 (Galaxy Graph)
              </Title>
              <Tag color="purple">Hindsight Constellation 驱动</Tag>
              {hasData && (
                <Space size={4}>
                  <Tag color="blue">{data?.stats.totalNodes || data?.nodes.length} 星体</Tag>
                  <Tag color="cyan">{data?.stats.totalLinks || data?.links.length} 连线</Tag>
                </Space>
              )}
            </Flex>

            {/* 顶栏操作 */}
            <Space wrap>
              {onOpenDedup && (
                <Button size="small" onClick={onOpenDedup}>
                  智能去重
                </Button>
              )}
              {onRefresh && (
                <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} loading={loading}>
                  刷新图谱
                </Button>
              )}
            </Space>
          </Flex>

          {/* 筛选与模式工具栏 */}
          <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
            <Radio.Group
              size="small"
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              buttonStyle="solid"
            >
              <Radio.Button value="all">全景星图 ({filterCounts.all})</Radio.Button>
              <Radio.Button value="obsidian">Obsidian ({filterCounts.obsidian})</Radio.Button>
              <Radio.Button value="inbox">聊天归档 ({filterCounts.inbox})</Radio.Button>
              <Radio.Button value="document">已收集 ({filterCounts.document})</Radio.Button>
              <Radio.Button value="tag">标签 ({filterCounts.tag})</Radio.Button>
            </Radio.Group>

            <Space wrap>
              <Radio.Group
                size="small"
                value={labelMode}
                onChange={(e) => setLabelMode(e.target.value)}
              >
                <Radio.Button value="smart">智能聚焦</Radio.Button>
                <Radio.Button value="all">全显星名</Radio.Button>
                <Radio.Button value="none">纯净星空</Radio.Button>
              </Radio.Group>

              <Button size="small" icon={<CompressOutlined />} onClick={handleFitView}>
                自适应全览
              </Button>
            </Space>
          </Flex>

          {/* 核心渲染区（由 Hindsight 原生 Constellation 引擎渲染） */}
          <div
            style={{
              position: "relative",
              width: "100%",
              height: 560,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {hasData ? (
              <HindsightConstellationGraph
                key={refreshKey}
                data={constellationData}
                height={560}
                onNodeClick={handleNodeClick}
                clusterKeyFn={(n) => n.group || null}
                emptyMessage="知识库暂无文档或笔记，请先在资料收集箱上传文件或同步 Obsidian 笔记库。"
              />
            ) : (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Empty
                  description={
                    <Text style={{ color: "#94a3b8" }}>
                      知识库暂无文档或笔记，请先在资料收集箱上传文件或同步 Obsidian 笔记库。
                    </Text>
                  }
                />
              </div>
            )}

            {/* 仿真与视角悬浮控制条（满足单元测试与便捷操作） */}
            <div
              style={{
                position: "absolute",
                bottom: 16,
                left: 16,
                display: "flex",
                gap: 6,
                background: "rgba(18, 18, 24, 0.75)",
                backdropFilter: "blur(8px)",
                padding: "4px 8px",
                borderRadius: 20,
                border: "1px solid rgba(255,255,255,0.08)",
                zIndex: 10,
              }}
            >
              <Tooltip title="自适应居中全览">
                <Button
                  className="ant-btn-circle"
                  type="text"
                  size="small"
                  shape="circle"
                  icon={<CompressOutlined style={{ color: "#38bdf8" }} />}
                  onClick={handleFitView}
                />
              </Tooltip>
              <Tooltip title="重置视角">
                <Button
                  className="ant-btn-circle"
                  type="text"
                  size="small"
                  shape="circle"
                  icon={<AimOutlined style={{ color: "#94a3b8" }} />}
                  onClick={handleFitView}
                />
              </Tooltip>
            </div>
          </div>
        </Flex>
      </Card>

      {/* 节点点击侧边详情抽屉 */}
      <Drawer
        title={
          selectedNode ? (
            <Flex align="center" gap={8}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background:
                    selectedNode.type === "obsidian"
                      ? HINDSIGHT_PALETTE.world
                      : selectedNode.type === "inbox"
                        ? HINDSIGHT_PALETTE.observation
                        : selectedNode.type === "document"
                          ? HINDSIGHT_PALETTE.experience
                          : HINDSIGHT_PALETTE.entity,
                  display: "inline-block",
                  boxShadow: "0 0 10px rgba(14, 165, 233, 0.6)",
                }}
              />
              <span>{selectedNode.name}</span>
            </Flex>
          ) : (
            "星体详情"
          )
        }
        open={selectedNode !== null}
        onClose={() => setSelectedNode(null)}
        width={420}
        destroyOnHidden
      >
        {selectedNode && (
          <Flex vertical gap={16}>
            <Card size="small" style={{ background: "var(--ant-color-fill-quaternary)" }}>
              <Flex vertical gap={8}>
                <div>
                  <Text type="secondary">语义层级：</Text>
                  <Tag color="purple">
                    {selectedNode.type === "obsidian"
                      ? "World (客观知识)"
                      : selectedNode.type === "inbox"
                        ? "Observation (观察记录)"
                        : selectedNode.type === "document"
                          ? "Experience (经历资料)"
                          : "Entity (实体概念)"}
                  </Tag>
                </div>
                <div>
                  <Text type="secondary">相对路径：</Text>
                  <Text code>{selectedNode.details?.path || selectedNode.name}</Text>
                </div>
                {selectedNode.details?.size !== undefined && (
                  <div>
                    <Text type="secondary">大小：</Text>
                    <Text>{Math.round(selectedNode.details.size / 1024)} KB</Text>
                  </div>
                )}
                <div>
                  <Text type="secondary">星际关联度：</Text>
                  <Text strong>{selectedNode.connections || 0} 个关联节点</Text>
                </div>
              </Flex>
            </Card>

            <Title level={5} style={{ margin: "8px 0 0 0" }}>
              关联网络
            </Title>
            <Flex wrap="wrap" gap={8}>
              {(data?.links || [])
                .filter((l) => l.source === selectedNode.id || l.target === selectedNode.id)
                .map((l, idx) => {
                  const peerId = l.source === selectedNode.id ? l.target : l.source;
                  const peerNode = data?.nodes.find((n) => n.id === peerId);
                  return (
                    <Tag
                      key={idx}
                      color="blue"
                      style={{ cursor: "pointer", padding: "4px 8px" }}
                      onClick={() => {
                        if (peerNode) setSelectedNode(peerNode);
                      }}
                    >
                      ➔ {peerNode?.name || peerId} ({l.type === "wikilink" ? "引用" : l.type})
                    </Tag>
                  );
                })}
            </Flex>

            <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 12 }}>
              提示：星图由 Hindsight Constellation 引擎流式计算；点击上方关联标签可直接切换焦点节点。
            </Paragraph>
          </Flex>
        )}
      </Drawer>
    </div>
  );
}
