/**
 * 知识图谱（星图 / Galaxy Knowledge Graph）：
 * - 银河深空暗黑星系风格（Canvas 60fps 原生力导向天体物理引擎）；
 * - 天体尺度自适应与硬碰撞保护（杜绝节点叠压成死结与巨型色块）；
 * - 智能注记层级 (LOD) 与空间贪心碰撞剔除（彻底消灭文字重叠与视觉污染）；
 * - 丝状微星轨与深空星尘粒子渲染（媲美 Obsidian / visionOS 沉浸式图谱）；
 * - 支持自适应全览居中、缩放平移、悬停邻居星轨高亮、搜索定位与抽屉详情跃迁；
 * - 纯前端高性能实现，零重度外部图谱库依赖。
 */
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  Button,
  Card,
  Drawer,
  Empty,
  Flex,
  Input,
  Radio,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  AimOutlined,
  BookOutlined,
  CaretRightOutlined,
  CompressOutlined,
  FileDoneOutlined,
  FileTextOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  MessageOutlined,
  PauseOutlined,
  ReloadOutlined,
  SearchOutlined,
  TagOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";

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

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  targetColor: string;
}

interface SimLink {
  source: SimNode;
  target: SimNode;
  type: string;
  length: number;
}

interface StardustPoint {
  x: number;
  y: number;
  r: number;
  alpha: number;
  color: string;
}

const TYPE_CONFIG: Record<
  string,
  { label: string; color: string; glow: string; icon: typeof BookOutlined }
> = {
  obsidian: {
    label: "Obsidian 笔记",
    color: "#00e5ff",
    glow: "rgba(0, 229, 255, 0.4)",
    icon: BookOutlined,
  },
  document: {
    label: "收集箱文档",
    color: "#b388ff",
    glow: "rgba(179, 136, 255, 0.4)",
    icon: FileTextOutlined,
  },
  inbox: {
    label: "聊天归档文件",
    color: "#00e676",
    glow: "rgba(0, 230, 118, 0.4)",
    icon: MessageOutlined,
  },
  tag: {
    label: "标签星尘",
    color: "#ffd700",
    glow: "rgba(255, 215, 0, 0.4)",
    icon: TagOutlined,
  },
  concept: {
    label: "核心枢纽",
    color: "#2979ff",
    glow: "rgba(41, 121, 255, 0.5)",
    icon: FileDoneOutlined,
  },
};

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
  const cardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 视口平移与缩放 (Transform)
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const [filterType, setFilterType] = useState<string>("all");
  const [labelMode, setLabelMode] = useState<"smart" | "all" | "none">("smart");
  const [searchKeyword, setSearchKeyword] = useState<string>("");
  const [selectedNode, setSelectedNode] = useState<SimNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<SimNode | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isPhysicsPaused, setIsPhysicsPaused] = useState<boolean>(false);

  // 物理温度与阻尼控制
  const simAlphaRef = useRef(1.0);
  const isPhysicsPausedRef = useRef(false);
  isPhysicsPausedRef.current = isPhysicsPaused;

  // 静态深空微星背景粒子
  const stardustRef = useRef<StardustPoint[]>([]);

  // 分类节点计数统计
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

  // 节点分类筛选可见性判定
  const isNodeVisible = useCallback(
    (n: SimNode): boolean => {
      if (filterType === "all") return true;
      if (filterType === "obsidian") {
        return n.type === "obsidian" || (n.type === "concept" && n.connections > 1);
      }
      if (filterType === "document") return n.type === "document";
      if (filterType === "inbox") return n.type === "inbox";
      if (filterType === "tag") return n.type === "tag";
      return n.type === filterType;
    },
    [filterType],
  );

  const handleFilterChange = (newType: string) => {
    setFilterType(newType);
    setSelectedNode(null);
    setHoveredNode(null);
    simAlphaRef.current = 0.8;
  };

  // 力导向模拟节点与连接
  const simNodesRef = useRef<SimNode[]>([]);
  const simLinksRef = useRef<SimLink[]>([]);
  const isDraggingRef = useRef(false);
  const draggedNodeRef = useRef<SimNode | null>(null);
  const panStartRef = useRef({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const animFrameIdRef = useRef<number | null>(null);

  // 初始化物理节点（采用黄金螺旋 Fermat's Spiral 均匀铺展 + 真实天体尺寸比例）
  useEffect(() => {
    if (!data || !data.nodes || data.nodes.length === 0) {
      simNodesRef.current = [];
      simLinksRef.current = [];
      return;
    }

    const width = containerRef.current?.clientWidth || 900;
    const height = containerRef.current?.clientHeight || 600;
    const centerX = width / 2;
    const centerY = height / 2;

    const count = data.nodes.length;
    const isDense = count > 100;
    // 动态星系初始扩散半径：600+ 节点时宽广展开，赋予开阔星河感
    const spreadRadius = Math.max(480, Math.sqrt(count) * 52);
    const goldenAngle = 137.50776405003785 * (Math.PI / 180);

    const nodeMap = new Map<string, SimNode>();

    const simNodes: SimNode[] = data.nodes.map((node, i) => {
      // 天体尺寸自适应：当节点较多时，收敛至优雅的星体微圆（2.2px ~ 7.5px），绝不出现膨胀巨块
      let radius = 3.0;
      if (isDense) {
        if (node.type === "concept") {
          radius = Math.min(7.5, Math.max(4.5, 4.0 + Math.log2((node.connections || 1) + 1) * 0.75));
        } else if (node.type === "tag") {
          radius = Math.min(4.2, Math.max(2.0, 1.8 + Math.log2((node.connections || 1) + 1) * 0.5));
        } else {
          radius = Math.min(5.5, Math.max(2.4, 2.2 + Math.log2((node.connections || 1) + 1) * 0.65));
        }
      } else {
        radius = Math.min(10, Math.max(4.0, Math.round(node.val * 0.45) + 2));
      }

      // Fermat's Spiral 黄金螺旋散布
      const rRatio = Math.sqrt((i + 1) / (count || 1));
      const dist = 60 + rRatio * spreadRadius;
      const angle = i * goldenAngle;
      const cfg = TYPE_CONFIG[node.type] || TYPE_CONFIG["document"];

      const sn: SimNode = {
        ...node,
        x: centerX + Math.cos(angle) * dist,
        y: centerY + Math.sin(angle) * dist,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
        radius,
        targetColor: cfg.color,
      };
      nodeMap.set(node.id, sn);
      return sn;
    });

    const simLinks: SimLink[] = [];
    for (const link of data.links) {
      const s = nodeMap.get(link.source);
      const t = nodeMap.get(link.target);
      if (s && t) {
        const baseLen = link.type === "tag" ? 65 : 95;
        const degBonus = Math.min(80, (s.connections + t.connections) * 2.2);
        simLinks.push({
          source: s,
          target: t,
          type: link.type,
          length: baseLen + degBonus,
        });
      }
    }

    simNodesRef.current = simNodes;
    simLinksRef.current = simLinks;
    simAlphaRef.current = 1.0;

    // 生成微星背景粒子
    const stars: StardustPoint[] = [];
    const colors = ["#ffffff", "#67e8f9", "#38bdf8", "#fde047", "#c084fc"];
    for (let sIdx = 0; sIdx < 140; sIdx++) {
      stars.push({
        x: (Math.sin(sIdx * 991.1) * 0.5 + 0.5) * 2400 - 400,
        y: (Math.cos(sIdx * 433.7) * 0.5 + 0.5) * 1800 - 300,
        r: Math.random() * 1.2 + 0.4,
        alpha: Math.random() * 0.4 + 0.1,
        color: colors[sIdx % colors.length] || "#fff",
      });
    }
    stardustRef.current = stars;

    // 数据加载完毕后执行一次自适应全览
    const timer = setTimeout(() => {
      handleFitView();
    }, 180);
    return () => clearTimeout(timer);
  }, [data]);

  // 自适应全览居中 (Auto-Fit View)
  const handleFitView = useCallback(() => {
    const canvas = canvasRef.current;
    const nodes = simNodesRef.current;
    if (!canvas || !nodes || nodes.length === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const n of nodes) {
      if (!isNodeVisible(n)) continue;
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }

    if (!isFinite(minX) || !isFinite(maxX)) return;

    const width = canvas.width || 900;
    const height = canvas.height || 600;
    const boundW = Math.max(120, maxX - minX);
    const boundH = Math.max(120, maxY - minY);
    const padding = 70;

    const scaleX = (width - padding * 2) / boundW;
    const scaleY = (height - padding * 2) / boundH;
    const fitScale = Math.min(1.8, Math.max(0.35, Math.min(scaleX, scaleY)));

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    transformRef.current = {
      scale: fitScale,
      x: width / 2 - centerX * fitScale,
      y: height / 2 - centerY * fitScale,
    };
  }, [isNodeVisible]);

  // 力导向动力学每帧更新（含硬碰撞规避与模拟退火降温）
  const updatePhysics = useCallback(() => {
    const nodes = simNodesRef.current;
    const links = simLinksRef.current;
    if (!nodes || nodes.length === 0 || isPhysicsPausedRef.current) return;

    const alpha = simAlphaRef.current;
    if (alpha < 0.015 && !draggedNodeRef.current) {
      return; // 星系已稳定平衡，停止无谓 CPU 消耗
    }

    const width = containerRef.current?.clientWidth || 900;
    const height = containerRef.current?.clientHeight || 600;
    const centerX = width / 2;
    const centerY = height / 2;

    // 1. 节点间硬碰撞规避 (Hard Collision Barrier) + 长程平滑斥力
    const maxRepulseDist = 260;
    const maxRepulseDistSq = maxRepulseDist * maxRepulseDist;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy;

        // 硬碰撞隔离：保证任意两个星体之间保留至少 6px 净空，绝不挤压重合
        const minDist = a.radius + b.radius + 6;
        const minDistSq = minDist * minDist;
        if (distSq < minDistSq) {
          const dist = Math.sqrt(distSq) || 0.1;
          const overlap = minDist - dist;
          const nx = dx / dist;
          const ny = dy / dist;
          const pushForce = overlap * 0.48;
          a.x -= nx * pushForce;
          a.y -= ny * pushForce;
          b.x += nx * pushForce;
          b.y += ny * pushForce;
          a.vx -= nx * pushForce * 0.15;
          a.vy -= ny * pushForce * 0.15;
          b.vx += nx * pushForce * 0.15;
          b.vy += ny * pushForce * 0.15;
          continue;
        }

        // 平滑长程排斥
        if (distSq < maxRepulseDistSq) {
          const dist = Math.sqrt(distSq);
          const force = (Math.min(22, 1900 / (distSq + 120))) * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }
    }

    // 2. 边弹簧引力 (Adaptive Spring Attraction)
    for (const link of links) {
      const a = link.source;
      const b = link.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const delta = dist - link.length;
      // 枢纽阻尼：避免高度关联的核心星体把整片卫星强行拽成死团
      const hubDamp = Math.max(1, Math.sqrt(a.connections * b.connections) * 0.28);
      const force = ((delta / hubDamp) * 0.016) * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx += fx;
      b.vy += fy;
    }

    // 3. 极弱向心引力与平滑阻尼摩擦 (微引力使星系自然舒展呈银河盘状)
    const centerGravity = Math.min(0.00015, Math.max(0.00004, 1 / (nodes.length * 15 + 4000))) * alpha;
    for (const n of nodes) {
      if (draggedNodeRef.current === n) continue;
      const cdx = centerX - n.x;
      const cdy = centerY - n.y;
      n.vx += cdx * centerGravity;
      n.vy += cdy * centerGravity;

      n.vx *= 0.84;
      n.vy *= 0.84;
      n.x += n.vx;
      n.y += n.vy;
    }

    // 模拟退火降温 (Cooling)
    simAlphaRef.current = Math.max(0.01, simAlphaRef.current * 0.994);
  }, []);

  // 渲染星空图谱到 Canvas
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const { x: panX, y: panY, scale } = transformRef.current;

    // 清空背景（深邃星空渐变）
    const bgGrad = ctx.createRadialGradient(
      width / 2,
      height / 2,
      40,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.85,
    );
    bgGrad.addColorStop(0, "#0b1220");
    bgGrad.addColorStop(0.5, "#070b14");
    bgGrad.addColorStop(1, "#030509");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // 绘制深空微星背景粒子
    const stardust = stardustRef.current;
    for (const star of stardust) {
      const sx = (star.x * scale * 0.35 + panX * 0.15) % width;
      const sy = (star.y * scale * 0.35 + panY * 0.15) % height;
      const finalX = sx < 0 ? sx + width : sx;
      const finalY = sy < 0 ? sy + height : sy;
      ctx.beginPath();
      ctx.arc(finalX, finalY, star.r, 0, Math.PI * 2);
      ctx.fillStyle = star.color;
      ctx.globalAlpha = star.alpha;
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    const nodes = simNodesRef.current;
    const links = simLinksRef.current;
    const hovered = hoveredNode;
    const selected = selectedNode;

    // 找出与悬停/选中节点关联的邻居与连线
    const activeNodeId = hovered?.id || selected?.id;
    const connectedNodeIds = new Set<string>();
    if (activeNodeId) {
      connectedNodeIds.add(activeNodeId);
      for (const l of links) {
        if (l.source.id === activeNodeId) connectedNodeIds.add(l.target.id);
        if (l.target.id === activeNodeId) connectedNodeIds.add(l.source.id);
      }
    }

    // 1. 绘制星际丝状连线 (Filaments)
    for (const link of links) {
      if (!isNodeVisible(link.source) || !isNodeVisible(link.target)) {
        continue;
      }

      const isConnected =
        activeNodeId &&
        (link.source.id === activeNodeId || link.target.id === activeNodeId);
      const isDimmed = activeNodeId && !isConnected;

      ctx.beginPath();
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);

      if (isConnected) {
        ctx.strokeStyle = "rgba(0, 229, 255, 0.88)";
        ctx.lineWidth = 1.8;
        ctx.shadowColor = "#00e5ff";
        ctx.shadowBlur = 8;
      } else if (isDimmed) {
        ctx.strokeStyle = "rgba(70, 130, 220, 0.04)";
        ctx.lineWidth = 0.5;
        ctx.shadowBlur = 0;
      } else {
        // 非选中态连线保持细微丝状，彻底解决千条连线形成蜘蛛网亮斑的问题
        ctx.strokeStyle =
          link.type === "wikilink"
            ? "rgba(56, 189, 248, 0.12)"
            : link.type === "tag"
              ? "rgba(234, 179, 8, 0.08)"
              : "rgba(168, 85, 247, 0.1)";
        ctx.lineWidth = 0.6;
        ctx.shadowBlur = 0;
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // 2. 绘制星辰节点 (Star Nodes)
    const now = Date.now();
    for (const n of nodes) {
      if (!isNodeVisible(n)) {
        continue;
      }

      const isMatched =
        !searchKeyword ||
        n.name.toLowerCase().includes(searchKeyword.toLowerCase());
      const isActive = connectedNodeIds.has(n.id);
      const isDimmed = (activeNodeId && !isActive) || !isMatched;

      const r = n.radius;
      const cfg = TYPE_CONFIG[n.type] || TYPE_CONFIG["document"];
      const baseAlpha = isDimmed ? 0.18 : 0.95;

      // 星体光晕 (Pulsing Halo)
      const pulse = Math.sin(now * 0.003 + n.x * 0.01) * 1.5;
      const glowRadius = r + (isActive ? 9 : 3.5) + (n.type === "concept" ? pulse : 0);

      const grad = ctx.createRadialGradient(n.x, n.y, r * 0.25, n.x, n.y, glowRadius);
      grad.addColorStop(0, cfg.color);
      grad.addColorStop(0.65, cfg.glow);
      grad.addColorStop(1, "rgba(0,0,0,0)");

      ctx.beginPath();
      ctx.arc(n.x, n.y, glowRadius, 0, 2 * Math.PI);
      ctx.fillStyle = grad;
      ctx.globalAlpha = baseAlpha * 0.75;
      ctx.fill();

      // 星体核心实心圆
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = cfg.color;
      ctx.globalAlpha = baseAlpha;
      if (isActive) {
        ctx.shadowColor = cfg.color;
        ctx.shadowBlur = 12;
      }
      ctx.fill();
      ctx.shadowBlur = 0;

      // 选中国界环 (Selected Orbit Ring)
      if (selected?.id === n.id) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4, 0, 2 * Math.PI);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // 3. 智能注记渲染 (LOD + 空间贪心碰撞剔除，彻底消灭重叠堆积)
    // 找出全图关键地标枢纽 (Top Hubs)
    const sortedHubs = [...nodes]
      .filter((n) => isNodeVisible(n))
      .sort((a, b) => b.connections - a.connections);
    const topHubIds = new Set(
      sortedHubs
        .slice(0, scale < 1.1 ? 6 : scale < 1.8 ? 16 : 40)
        .map((n) => n.id),
    );

    // 收集所有候选标签，并按优先级从高到低排序：Active 焦点 > 搜索命中 > 顶级地标 > 其他
    interface LabelCandidate {
      node: SimNode;
      priority: number;
      text: string;
      x: number;
      y: number;
      isActive: boolean;
    }

    const candidates: LabelCandidate[] = [];
    for (const n of nodes) {
      if (!isNodeVisible(n)) continue;

      const isMatched =
        Boolean(searchKeyword) &&
        n.name.toLowerCase().includes(searchKeyword.toLowerCase());
      const isActive = connectedNodeIds.has(n.id);
      const isDimmed = (activeNodeId && !isActive) || (!isActive && Boolean(searchKeyword) && !isMatched);

      let eligible = false;
      let priority = 0;

      if (isActive) {
        eligible = true;
        priority = 100;
      } else if (isMatched) {
        eligible = true;
        priority = 80;
      } else if (labelMode === "all") {
        eligible = !isDimmed;
        priority = n.connections;
      } else if (labelMode === "none") {
        eligible = false;
      } else {
        // "smart" (默认模式)
        if (topHubIds.has(n.id) && !isDimmed) {
          eligible = true;
          priority = 50 + n.connections;
        } else if (scale >= 2.0 && !isDimmed) {
          eligible = true;
          priority = n.connections;
        }
      }

      if (eligible) {
        const rawName = n.name;
        const displayName =
          isActive || hovered?.id === n.id || selected?.id === n.id
            ? rawName
            : rawName.length > 13
              ? rawName.slice(0, 12) + "…"
              : rawName;

        candidates.push({
          node: n,
          priority,
          text: displayName,
          x: n.x,
          y: n.y + n.radius + 12,
          isActive,
        });
      }
    }

    // 优先渲染高权重标签
    candidates.sort((a, b) => b.priority - a.priority);

    // 贪心矩形碰撞剔除 (Greedy Occlusion Bounding Box Check in screen space)
    interface ScreenBox {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
    const drawnBoxes: ScreenBox[] = [];

    ctx.font = "11px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";

    for (const c of candidates) {
      const textMetrics = ctx.measureText(c.text);
      const textWidth = textMetrics.width;
      const textHeight = 12;
      const padX = 6;
      const padY = 3;

      // 投影至屏幕像素坐标，计算精确重叠包围盒
      const screenTextX = c.x * scale + panX;
      const screenTextY = c.y * scale + panY;
      const boxW = (textWidth + padX * 2) * (scale < 1 ? 1 : 1);
      const boxH = (textHeight + padY * 2) * (scale < 1 ? 1 : 1);
      const bX1 = screenTextX - boxW / 2;
      const bY1 = screenTextY - boxH + 2;
      const bX2 = bX1 + boxW;
      const bY2 = bY1 + boxH;

      // 若非直接 active 焦点，检测是否与已绘制标签发生重叠
      if (!c.isActive && drawnBoxes.length > 0) {
        let collides = false;
        for (const prev of drawnBoxes) {
          if (
            bX1 < prev.x2 + 4 &&
            bX2 > prev.x1 - 4 &&
            bY1 < prev.y2 + 4 &&
            bY2 > prev.y1 - 4
          ) {
            collides = true;
            break;
          }
        }
        if (collides) {
          continue; // 跳过重叠标签，避免文字成泥
        }
      }

      drawnBoxes.push({ x1: bX1, y1: bY1, x2: bX2, y2: bY2 });

      // 绘制半透明微胶囊背板 (Dark Glass Capsule)
      const bgX = c.x - textWidth / 2 - padX;
      const bgY = c.y - textHeight + 1 - padY;
      const bgW = textWidth + padX * 2;
      const bgH = textHeight + padY * 2;

      ctx.beginPath();
      if (typeof (ctx as unknown as { roundRect?: (...args: number[]) => void }).roundRect === "function") {
        (ctx as unknown as { roundRect: (...args: number[]) => void }).roundRect(bgX, bgY, bgW, bgH, 4);
      } else {
        ctx.rect(bgX, bgY, bgW, bgH);
      }
      ctx.fillStyle = c.isActive
        ? "rgba(10, 18, 36, 0.95)"
        : "rgba(7, 12, 22, 0.85)";
      ctx.strokeStyle = c.isActive
        ? "rgba(0, 229, 255, 0.6)"
        : "rgba(255, 255, 255, 0.12)";
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      // 绘制标签文字
      ctx.fillStyle = c.isActive
        ? "#ffffff"
        : c.node.type === "concept"
          ? "#90caf9"
          : "rgba(224, 238, 255, 0.92)";
      ctx.textAlign = "center";
      ctx.fillText(c.text, c.x, c.y);
    }

    ctx.restore();
  }, [filterType, searchKeyword, hoveredNode, selectedNode, labelMode, isNodeVisible]);

  // 动画主循环
  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      updatePhysics();
      renderCanvas();
      animFrameIdRef.current = requestAnimationFrame(loop);
    };
    animFrameIdRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current);
    };
  }, [updatePhysics, renderCanvas]);

  // 自适应 Canvas 分辨率
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const width = container.clientWidth;
    const height = container.clientHeight || 750;
    canvas.width = width;
    canvas.height = height;
  }, []);

  useEffect(() => {
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, [resizeCanvas]);

  // 监听浏览器原生全屏状态
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFs = Boolean(
        document.fullscreenElement ||
          (document as unknown as { webkitFullscreenElement?: Element })
            .webkitFullscreenElement,
      );
      setIsFullscreen(isFs);
      setTimeout(() => resizeCanvas(), 100);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    };
  }, [resizeCanvas]);

  // 切换全屏状态
  const handleToggleFullscreen = async () => {
    const nextState = !isFullscreen;
    setIsFullscreen(nextState);
    if (nextState) {
      try {
        if (cardRef.current?.requestFullscreen) {
          await cardRef.current.requestFullscreen();
        } else if (
          (cardRef.current as unknown as { webkitRequestFullscreen?: () => Promise<void> })
            ?.webkitRequestFullscreen
        ) {
          await (
            cardRef.current as unknown as { webkitRequestFullscreen: () => Promise<void> }
          ).webkitRequestFullscreen();
        }
      } catch {
        /* 全屏 API 不可用时降级为 fixed 视口全屏 */
      }
    } else {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else if (
          (
            document as unknown as {
              webkitFullscreenElement?: Element;
              webkitExitFullscreen?: () => Promise<void>;
            }
          )?.webkitExitFullscreen
        ) {
          await (
            document as unknown as { webkitExitFullscreen: () => Promise<void> }
          ).webkitExitFullscreen();
        }
      } catch {
        /* 忽略 */
      }
    }
    setTimeout(() => resizeCanvas(), 120);
  };

  // 坐标换算：屏幕像素 -> 星系物理坐标
  const toWorldCoords = useCallback((screenX: number, screenY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const sx = screenX - rect.left;
    const sy = screenY - rect.top;
    const { x: panX, y: panY, scale } = transformRef.current;
    return {
      x: (sx - panX) / scale,
      y: (sy - panY) / scale,
    };
  }, []);

  // 碰撞检测拾取星辰节点（过滤不可见节点）
  const pickNode = useCallback(
    (screenX: number, screenY: number): SimNode | null => {
      const { x, y } = toWorldCoords(screenX, screenY);
      const nodes = simNodesRef.current;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (!isNodeVisible(n)) continue;
        const dx = n.x - x;
        const dy = n.y - y;
        const hitRadius = Math.max(8, n.radius + 5);
        if (dx * dx + dy * dy <= hitRadius * hitRadius) {
          return n;
        }
      }
      return null;
    },
    [toWorldCoords, isNodeVisible],
  );

  // 交互事件绑定
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const node = pickNode(e.clientX, e.clientY);
    if (node) {
      isDraggingRef.current = true;
      draggedNodeRef.current = node;
      simAlphaRef.current = 0.5; // 唤醒物理引擎
    } else {
      isPanningRef.current = true;
      panStartRef.current = {
        x: e.clientX - transformRef.current.x,
        y: e.clientY - transformRef.current.y,
      };
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current && draggedNodeRef.current) {
      const { x, y } = toWorldCoords(e.clientX, e.clientY);
      draggedNodeRef.current.x = x;
      draggedNodeRef.current.y = y;
      draggedNodeRef.current.vx = 0;
      draggedNodeRef.current.vy = 0;
    } else if (isPanningRef.current) {
      transformRef.current.x = e.clientX - panStartRef.current.x;
      transformRef.current.y = e.clientY - panStartRef.current.y;
    } else {
      const node = pickNode(e.clientX, e.clientY);
      setHoveredNode(node);
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      draggedNodeRef.current = null;
    }
    if (isPanningRef.current) {
      isPanningRef.current = false;
    }
    const node = pickNode(e.clientX, e.clientY);
    if (node) {
      setSelectedNode(node);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.88;
    const newScale = Math.min(3.5, Math.max(0.25, transformRef.current.scale * zoomFactor));

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    transformRef.current.x =
      mouseX - (mouseX - transformRef.current.x) * (newScale / transformRef.current.scale);
    transformRef.current.y =
      mouseY - (mouseY - transformRef.current.y) * (newScale / transformRef.current.scale);
    transformRef.current.scale = newScale;
  };

  // 缩放操作助手
  const handleZoom = (direction: "in" | "out") => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const factor = direction === "in" ? 1.25 : 0.8;
    const newScale = Math.min(3.5, Math.max(0.25, transformRef.current.scale * factor));
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    transformRef.current.x =
      centerX - (centerX - transformRef.current.x) * (newScale / transformRef.current.scale);
    transformRef.current.y =
      centerY - (centerY - transformRef.current.y) * (newScale / transformRef.current.scale);
    transformRef.current.scale = newScale;
  };

  // 重置视口
  const handleResetView = () => {
    transformRef.current = { x: 0, y: 0, scale: 1 };
    simAlphaRef.current = 0.6;
  };

  // 重新布局唤醒
  const handleReheatPhysics = () => {
    simAlphaRef.current = 0.9;
  };

  const stats = data?.stats || {
    totalNodes: 0,
    totalLinks: 0,
    docCount: 0,
    tagCount: 0,
  };

  return (
    <div
      ref={cardRef}
      style={{
        position: isFullscreen ? "fixed" : "relative",
        top: isFullscreen ? 0 : undefined,
        left: isFullscreen ? 0 : undefined,
        right: isFullscreen ? 0 : undefined,
        bottom: isFullscreen ? 0 : undefined,
        width: isFullscreen ? "100vw" : "100%",
        height: isFullscreen ? "100vh" : "auto",
        zIndex: isFullscreen ? 99999 : 1,
        borderRadius: isFullscreen ? 0 : 12,
        background: "#050811",
        border: isFullscreen ? "none" : "1px solid #1f293d",
        overflow: "hidden",
        display: isFullscreen ? "flex" : "block",
        flexDirection: "column",
      }}
    >
      <Card
        variant="borderless"
        style={{
          borderRadius: 0,
          background: "transparent",
          height: isFullscreen ? "100vh" : "auto",
          display: "flex",
          flexDirection: "column",
        }}
        styles={{
          body: {
            padding: 0,
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          },
        }}
      >
        {/* 顶部星图控制与分类过滤器 */}
        <Flex
          justify="space-between"
          align="center"
          wrap="wrap"
          gap={12}
          style={{
            padding: "10px 16px",
            background: "rgba(10, 16, 28, 0.95)",
            borderBottom: "1px solid #1f293d",
          }}
        >
          <Flex align="center" gap={12} wrap="wrap">
            <Flex align="center" gap={8}>
              <Title level={5} style={{ margin: 0, color: "#e6f4ff", fontSize: 15 }}>
                知识星图 (Galaxy Graph)
              </Title>
              <Tag color="cyan">{stats.totalNodes} 星体</Tag>
              <Tag color="blue">{stats.totalLinks} 连线</Tag>
              <Tag color="purple">{stats.docCount} 篇资料</Tag>
            </Flex>

            <Radio.Group
              size="small"
              value={filterType}
              onChange={(e) => handleFilterChange(e.target.value)}
              style={{ marginLeft: 4 }}
            >
              <Radio.Button value="all">全景星图 ({filterCounts.all})</Radio.Button>
              <Radio.Button value="obsidian">Obsidian ({filterCounts.obsidian})</Radio.Button>
              <Radio.Button value="document">收集箱 ({filterCounts.document})</Radio.Button>
              <Radio.Button value="inbox">聊天归档 ({filterCounts.inbox})</Radio.Button>
              <Radio.Button value="tag">标签 ({filterCounts.tag})</Radio.Button>
            </Radio.Group>

            {/* 标签显示模式切换器 */}
            <Radio.Group
              size="small"
              value={labelMode}
              onChange={(e) => setLabelMode(e.target.value)}
            >
              <Tooltip title="智能聚焦模式：仅展示核心枢纽与焦点连结星辰名称，彻底杜绝文字堆叠覆盖，保持静谧深邃星空">
                <Radio.Button value="smart">智能聚焦</Radio.Button>
              </Tooltip>
              <Tooltip title="全景星名模式：显示视野内星辰名称（自动执行防碰撞剔除）">
                <Radio.Button value="all">全显星名</Radio.Button>
              </Tooltip>
              <Tooltip title="纯净星空模式：隐藏标签文本，尽享宇宙万物拓扑与星际丝状轨道">
                <Radio.Button value="none">纯净星空</Radio.Button>
              </Tooltip>
            </Radio.Group>
          </Flex>

          <Flex align="center" gap={8} wrap="wrap">
            {onOpenDedup && (
              <Tooltip title="扫描并清理重复笔记与文档，释放冗余星体">
                <Button
                  size="small"
                  onClick={onOpenDedup}
                  style={{
                    background: "rgba(234, 88, 12, 0.15)",
                    borderColor: "rgba(234, 88, 12, 0.4)",
                    color: "#fb923c",
                  }}
                >
                  笔记去重
                </Button>
              </Tooltip>
            )}
            <Input
              size="small"
              placeholder="搜索星体/笔记名称..."
              prefix={<SearchOutlined style={{ color: "#64748b" }} />}
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              style={{ width: 170, background: "#131c2e", borderColor: "#27354f", color: "#fff" }}
              allowClear
            />
            <Tooltip title="自适应居中全览整座星系">
              <Button
                size="small"
                icon={<CompressOutlined />}
                onClick={handleFitView}
                style={{ background: "#131c2e", borderColor: "#27354f", color: "#38bdf8" }}
              >
                自适应全览
              </Button>
            </Tooltip>
            {onRefresh && (
              <Tooltip title="重新扫描并刷新星图数据">
                <Button
                  size="small"
                  icon={<ReloadOutlined spin={loading} />}
                  onClick={onRefresh}
                  style={{ background: "#131c2e", borderColor: "#27354f", color: "#e2e8f0" }}
                />
              </Tooltip>
            )}
            <Tooltip title={isFullscreen ? "退出全屏 (ESC)" : "沉浸全屏星图"}>
              <Button
                size="small"
                icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                onClick={handleToggleFullscreen}
                style={{
                  background: isFullscreen ? "rgba(0, 229, 255, 0.2)" : "#131c2e",
                  borderColor: isFullscreen ? "#00e5ff" : "#27354f",
                  color: isFullscreen ? "#00e5ff" : "#e2e8f0",
                }}
              />
            </Tooltip>
          </Flex>
        </Flex>

        {/* 星空画布容器 */}
        <div
          ref={containerRef}
          style={{
            position: "relative",
            width: "100%",
            flex: isFullscreen ? 1 : undefined,
            height: isFullscreen
              ? "calc(100vh - 54px)"
              : "max(740px, calc(100vh - 240px))",
            background: "#050811",
            cursor: isDraggingRef.current
              ? "grabbing"
              : hoveredNode
                ? "pointer"
                : isPanningRef.current
                  ? "move"
                  : "default",
          }}
        >
          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onWheel={handleWheel}
            style={{ display: "block", width: "100%", height: "100%" }}
          />

          {/* 悬停浮动卡片 (Hover Tooltip - 左下角优雅浮层) */}
          {hoveredNode && (
            <div
              style={{
                position: "absolute",
                bottom: 20,
                left: 20,
                padding: "10px 14px",
                background: "rgba(11, 19, 36, 0.88)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(56, 189, 248, 0.3)",
                borderRadius: 10,
                color: "#e2e8f0",
                maxWidth: 320,
                boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                pointerEvents: "none",
                animation: "fadeIn 0.15s ease-out",
              }}
            >
              <Flex align="center" gap={8} style={{ marginBottom: 4 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: hoveredNode.targetColor,
                    display: "inline-block",
                    boxShadow: `0 0 10px ${hoveredNode.targetColor}`,
                  }}
                />
                <Text strong style={{ color: "#fff", fontSize: 13 }}>
                  {hoveredNode.name}
                </Text>
              </Flex>
              <Flex gap={8} align="center">
                <Tag color="cyan" style={{ margin: 0, fontSize: 11 }}>
                  {TYPE_CONFIG[hoveredNode.type]?.label || hoveredNode.type}
                </Tag>
                <Text type="secondary" style={{ fontSize: 12, color: "#94a3b8" }}>
                  连结星轨: {hoveredNode.connections || 0}
                </Text>
              </Flex>
              {hoveredNode.details?.path && (
                <div style={{ marginTop: 4, fontSize: 11, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {hoveredNode.details.path}
                </div>
              )}
            </div>
          )}

          {/* 右下角沉浸式工具浮条 (Floating HUD Controls) */}
          <div
            style={{
              position: "absolute",
              bottom: 20,
              right: 20,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 8px",
              background: "rgba(10, 16, 28, 0.85)",
              backdropFilter: "blur(12px)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              borderRadius: 24,
              boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
            }}
          >
            <Tooltip title="放大视角">
              <Button
                type="text"
                size="small"
                shape="circle"
                icon={<ZoomInOutlined style={{ color: "#94a3b8" }} />}
                onClick={() => handleZoom("in")}
              />
            </Tooltip>
            <Tooltip title="缩小视角">
              <Button
                type="text"
                size="small"
                shape="circle"
                icon={<ZoomOutOutlined style={{ color: "#94a3b8" }} />}
                onClick={() => handleZoom("out")}
              />
            </Tooltip>
            <Tooltip title="自适应居中全览">
              <Button
                type="text"
                size="small"
                shape="circle"
                icon={<CompressOutlined style={{ color: "#38bdf8" }} />}
                onClick={handleFitView}
              />
            </Tooltip>
            <Tooltip title="重置视角 (1:1)">
              <Button
                type="text"
                size="small"
                shape="circle"
                icon={<AimOutlined style={{ color: "#94a3b8" }} />}
                onClick={handleResetView}
              />
            </Tooltip>
            <Tooltip title={isPhysicsPaused ? "恢复天体动力学模拟" : "暂停物理引力结算（锁定天体坐标）"}>
              <Button
                type="text"
                size="small"
                shape="circle"
                icon={
                  isPhysicsPaused ? (
                    <CaretRightOutlined style={{ color: "#34d399" }} />
                  ) : (
                    <PauseOutlined style={{ color: "#94a3b8" }} />
                  )
                }
                onClick={() => setIsPhysicsPaused(!isPhysicsPaused)}
              />
            </Tooltip>
            <Tooltip title="重新唤醒引力舒展星系">
              <Button
                type="text"
                size="small"
                shape="circle"
                icon={<ReloadOutlined style={{ color: "#94a3b8" }} />}
                onClick={handleReheatPhysics}
              />
            </Tooltip>
          </div>

          {/* 空数据蒙层 */}
          {(!data || data.nodes.length === 0) && !loading && (
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
        </div>

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
                    background: selectedNode.targetColor,
                    display: "inline-block",
                    boxShadow: `0 0 10px ${selectedNode.targetColor}`,
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
                    <Text type="secondary">类型：</Text>
                    <Tag color="cyan">
                      {TYPE_CONFIG[selectedNode.type]?.label || selectedNode.type}
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
                    <Text strong>{selectedNode.connections || 0} 个关联星体</Text>
                  </div>
                </Flex>
              </Card>

              <Title level={5} style={{ margin: "8px 0 0 0" }}>
                关联星体与引力轨道
              </Title>
              <Flex wrap="wrap" gap={8}>
                {simLinksRef.current
                  .filter(
                    (l) =>
                      l.source.id === selectedNode.id ||
                      l.target.id === selectedNode.id,
                  )
                  .map((l, idx) => {
                    const peer =
                      l.source.id === selectedNode.id ? l.target : l.source;
                    return (
                      <Tag
                        key={idx}
                        color="blue"
                        style={{ cursor: "pointer", padding: "4px 8px" }}
                        onClick={() => setSelectedNode(peer)}
                      >
                        {peer.name} ({l.type})
                      </Tag>
                    );
                  })}
              </Flex>

              <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 12 }}>
                提示：点击上方关联标签可直接跃迁至对应星体视角；在左侧收集箱中可对文档进行切片更新或删除。
              </Paragraph>
            </Flex>
          )}
        </Drawer>
      </Card>
    </div>
  );
}
