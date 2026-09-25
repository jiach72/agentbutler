/**
 * 知识图谱（星图 / Galaxy Knowledge Graph）：
 * - 银河深空暗黑风格（Canvas 60fps 原生力导向图谱）；
 * - 星系节点分类渲染（Cyan=Obsidian 笔记, Purple=直传文档, Emerald=微信/IM归档, Gold=标签, Blue=核心枢纽）；
 * - 支持滚轮缩放、平移拖拽、悬停高亮邻接星轨、搜索定位与点击右侧抽屉详情；
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
  FileDoneOutlined,
  FileTextOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  MessageOutlined,
  ReloadOutlined,
  SearchOutlined,
  TagOutlined,
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

  // 节点分类筛选可见性判定（严格控制只有当前分类节点与连线在画布上呈现）
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
    transformRef.current = { x: 0, y: 0, scale: 1 };
  };

  // 力导向模拟节点与连接
  const simNodesRef = useRef<SimNode[]>([]);
  const simLinksRef = useRef<SimLink[]>([]);
  const isDraggingRef = useRef(false);
  const draggedNodeRef = useRef<SimNode | null>(null);
  const panStartRef = useRef({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const animFrameIdRef = useRef<number | null>(null);

  // 初始化物理节点（采用黄金螺旋 Fermat's Spiral 铺展，避免节点堆叠成死结）
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

    const nodeMap = new Map<string, SimNode>();
    const count = data.nodes.length;
    // 动态星系初始扩散半径：600+ 节点时自然散开至大银河盘，不拥挤
    const spreadRadius = Math.max(380, Math.sqrt(count) * 44);
    const goldenAngle = 137.50776405003785 * (Math.PI / 180);

    const simNodes: SimNode[] = data.nodes.map((node, i) => {
      const radius = Math.min(20, Math.max(5, Math.round(node.val * 0.72)));
      // Fermat's Spiral 黄金螺旋散布
      const rRatio = Math.sqrt((i + 1) / (count || 1));
      const dist = 50 + rRatio * spreadRadius;
      const angle = i * goldenAngle;
      const cfg = TYPE_CONFIG[node.type] || TYPE_CONFIG["document"];

      const sn: SimNode = {
        ...node,
        x: centerX + Math.cos(angle) * dist,
        y: centerY + Math.sin(angle) * dist,
        vx: (Math.random() - 0.5) * 1.2,
        vy: (Math.random() - 0.5) * 1.2,
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
        simLinks.push({
          source: s,
          target: t,
          type: link.type,
          length: link.type === "tag" ? 90 : 130,
        });
      }
    }

    simNodesRef.current = simNodes;
    simLinksRef.current = simLinks;
    transformRef.current = { x: 0, y: 0, scale: 1 };
  }, [data]);

  // 力导向动力学每帧更新
  const updatePhysics = useCallback(() => {
    const nodes = simNodesRef.current;
    const links = simLinksRef.current;
    if (!nodes || nodes.length === 0) return;

    const width = containerRef.current?.clientWidth || 900;
    const height = containerRef.current?.clientHeight || 600;
    const centerX = width / 2;
    const centerY = height / 2;

    // 1. 节点间斥力 (Repulsion) - 增加距离阈值过滤，杜绝全量 O(N^2) 性能损耗与过度排斥
    const maxRepulseDist = 320;
    const maxRepulseDistSq = maxRepulseDist * maxRepulseDist;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy + 64;
        if (distSq < maxRepulseDistSq) {
          const dist = Math.sqrt(distSq);
          const force = 1400 / distSq;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }
    }

    // 2. 边引力 (Spring Attraction)
    for (const link of links) {
      const a = link.source;
      const b = link.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const delta = dist - link.length;
      const force = delta * 0.028;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // 3. 银河中心向心微引力与平滑阻尼摩擦 (大幅减小向心力，防止几百个星体挤在一坨)
    const centerGravity = Math.min(0.0007, Math.max(0.0002, 1 / (nodes.length * 4 + 800)));
    for (const n of nodes) {
      if (draggedNodeRef.current === n) continue;
      const cdx = centerX - n.x;
      const cdy = centerY - n.y;
      n.vx += cdx * centerGravity;
      n.vy += cdy * centerGravity;

      n.vx *= 0.86;
      n.vy *= 0.86;
      n.x += n.vx;
      n.y += n.vy;
    }
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
      50,
      width / 2,
      height / 2,
      Math.max(width, height),
    );
    bgGrad.addColorStop(0, "#0e1526");
    bgGrad.addColorStop(0.5, "#090d18");
    bgGrad.addColorStop(1, "#04060a");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

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
      // 若任一端点不符合当前分类筛选，直接跳过不画该连线！
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
        ctx.strokeStyle = "rgba(0, 229, 255, 0.8)";
        ctx.lineWidth = 2.2;
        ctx.shadowColor = "#00e5ff";
        ctx.shadowBlur = 8;
      } else if (isDimmed) {
        ctx.strokeStyle = "rgba(100, 140, 200, 0.08)";
        ctx.lineWidth = 0.8;
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle =
          link.type === "wikilink"
            ? "rgba(140, 190, 255, 0.35)"
            : "rgba(255, 215, 0, 0.25)";
        ctx.lineWidth = 1.2;
        ctx.shadowBlur = 0;
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // 2. 绘制星辰节点 (Star Nodes)
    const now = Date.now();
    for (const n of nodes) {
      // 若节点不属于当前分类筛选，直接跳过不绘制！彻底呈现清晰分类星系
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
      const baseAlpha = isDimmed ? 0.2 : 0.95;

      // 星体光晕 (Pulsing Glow)
      const pulse = Math.sin(now * 0.003 + n.x * 0.01) * 2;
      const glowRadius = r + (isActive ? 12 : 5) + (n.type === "concept" ? pulse : 0);

      const grad = ctx.createRadialGradient(n.x, n.y, r * 0.3, n.x, n.y, glowRadius);
      grad.addColorStop(0, cfg.color);
      grad.addColorStop(0.6, cfg.glow);
      grad.addColorStop(1, "rgba(0,0,0,0)");

      ctx.beginPath();
      ctx.arc(n.x, n.y, glowRadius, 0, 2 * Math.PI);
      ctx.fillStyle = grad;
      ctx.globalAlpha = baseAlpha * 0.8;
      ctx.fill();

      // 星体核心实心圆
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = cfg.color;
      ctx.globalAlpha = baseAlpha;
      ctx.shadowColor = cfg.color;
      ctx.shadowBlur = isActive ? 16 : 8;
      ctx.fill();
      ctx.shadowBlur = 0;

      // 选中国界环
      if (selected?.id === n.id) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 5, 0, 2 * Math.PI);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // 文本星名标注判定与优雅气泡渲染 (彻底杜绝多文本覆盖死锁与视觉污染)
      let showLabel = false;
      if (labelMode === "all") {
        showLabel = !isDimmed || isActive;
      } else if (labelMode === "none") {
        showLabel = isActive || hovered?.id === n.id || selected?.id === n.id;
      } else {
        // "smart" (默认模式：消除文字死锁重叠，恢复静谧深邃星系)
        // 仅在以下情况显示文字：
        // 1. 当前悬停/选中星体或其 1 度相连邻居
        // 2. 搜索框命中
        // 3. 核心枢纽节点 (concept 或 connections >= 4)，且当视口适度放大 (scale >= 0.72)
        showLabel =
          isActive ||
          (Boolean(searchKeyword) && isMatched) ||
          ((n.type === "concept" || n.connections >= 4) && scale >= 0.72 && !isDimmed);
      }

      if (showLabel) {
        // 文本截断保护：非 active/hover/selected 的长名称截断至 13 字符，hover 时显示完整全称
        const rawName = n.name;
        const displayName =
          isActive || hovered?.id === n.id || selected?.id === n.id
            ? rawName
            : rawName.length > 13
              ? rawName.slice(0, 12) + "…"
              : rawName;

        ctx.font = isActive
          ? "bold 13px system-ui, -apple-system, sans-serif"
          : "11px system-ui, -apple-system, sans-serif";
        const textMetrics = ctx.measureText(displayName);
        const textWidth = textMetrics.width;
        const textHeight = 13;
        const textX = n.x;
        const textY = n.y + r + 15;

        // 绘制半透明微胶囊背板 (保护文字不被星轨与临近星芒遮挡穿透)
        const padX = 6;
        const padY = 3;
        const bgX = textX - textWidth / 2 - padX;
        const bgY = textY - textHeight + 1 - padY;
        const bgW = textWidth + padX * 2;
        const bgH = textHeight + padY * 2;

        ctx.beginPath();
        if (typeof (ctx as unknown as { roundRect?: (...args: number[]) => void }).roundRect === "function") {
          (ctx as unknown as { roundRect: (...args: number[]) => void }).roundRect(bgX, bgY, bgW, bgH, 4);
        } else {
          ctx.rect(bgX, bgY, bgW, bgH);
        }
        ctx.fillStyle = isActive ? "rgba(10, 18, 36, 0.92)" : "rgba(6, 10, 20, 0.82)";
        ctx.strokeStyle = isActive ? "rgba(0, 229, 255, 0.5)" : "rgba(255, 255, 255, 0.12)";
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();

        // 绘制文字
        ctx.fillStyle = isActive
          ? "#ffffff"
          : n.type === "concept"
            ? "#90caf9"
            : "rgba(220, 235, 255, 0.92)";
        ctx.textAlign = "center";
        ctx.fillText(displayName, textX, textY);
      }
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

  // 监听浏览器原生全屏状态（兼容 ESC 键退出全屏同步）
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

  // 切换全屏状态（HTML5 requestFullscreen 原生全屏 + Fixed 视口置顶双保障）
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
        /* 忽略全屏 API 异常 */
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
        /* 忽略全屏 API 异常 */
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

  // 碰撞检测拾取星辰节点（过滤掉不可见节点）
  const pickNode = useCallback(
    (screenX: number, screenY: number): SimNode | null => {
      const { x, y } = toWorldCoords(screenX, screenY);
      const nodes = simNodesRef.current;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (!isNodeVisible(n)) continue;
        const dx = n.x - x;
        const dy = n.y - y;
        if (dx * dx + dy * dy <= (n.radius + 6) * (n.radius + 6)) {
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
    const newScale = Math.min(3.5, Math.max(0.3, transformRef.current.scale * zoomFactor));

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // 以鼠标所在点为中心缩放
    transformRef.current.x =
      mouseX - (mouseX - transformRef.current.x) * (newScale / transformRef.current.scale);
    transformRef.current.y =
      mouseY - (mouseY - transformRef.current.y) * (newScale / transformRef.current.scale);
    transformRef.current.scale = newScale;
  };

  // 重置视口居中
  const handleResetView = () => {
    transformRef.current = { x: 0, y: 0, scale: 1 };
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
        background: "#080c16",
        border: isFullscreen ? "none" : "1px solid #1f293d",
        overflow: "hidden",
        display: isFullscreen ? "flex" : "block",
        flexDirection: "column",
      }}
    >
      <Card
        bordered={false}
        style={{
          borderRadius: 0,
          background: "transparent",
          height: isFullscreen ? "100vh" : "auto",
          display: "flex",
          flexDirection: "column",
        }}
        bodyStyle={{
          padding: 0,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* 顶部星图控制与分类过滤器 */}
        <Flex
          justify="space-between"
          align="center"
          wrap="wrap"
          gap={12}
          style={{
            padding: "12px 16px",
            background: "rgba(10, 16, 28, 0.95)",
            borderBottom: "1px solid #1f293d",
          }}
        >
          <Flex align="center" gap={12} wrap="wrap">
            <Flex align="center" gap={8}>
              <Title level={5} style={{ margin: 0, color: "#e6f4ff" }}>
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
              style={{ marginLeft: 8 }}
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
              <Tooltip title="仅高亮焦点/悬停星辰与关键枢纽，消除文字重叠，还原纯净星系">
                <Radio.Button value="smart">智能聚焦</Radio.Button>
              </Tooltip>
              <Tooltip title="显示全部可见节点的名称标签">
                <Radio.Button value="all">全部星名</Radio.Button>
              </Tooltip>
              <Tooltip title="隐藏所有标签文字，仅享受浩瀚星空">
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
            <Tooltip title="居中还原视口">
              <Button
                size="small"
                icon={<AimOutlined />}
                onClick={handleResetView}
                style={{ background: "#131c2e", borderColor: "#27354f", color: "#e2e8f0" }}
              />
            </Tooltip>
            {onRefresh && (
              <Tooltip title="重新扫描并刷新星图">
                <Button
                  size="small"
                  icon={<ReloadOutlined spin={loading} />}
                  onClick={onRefresh}
                  style={{ background: "#131c2e", borderColor: "#27354f", color: "#e2e8f0" }}
                />
              </Tooltip>
            )}
            <Tooltip title={isFullscreen ? "退出全屏 (ESC)" : "真正全屏星图"}>
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

        {/* 星空画布容器：大幅增加高度至自适应铺满屏，全屏时充满 100vh */}
        <div
          ref={containerRef}
          style={{
            position: "relative",
            width: "100%",
            flex: isFullscreen ? 1 : undefined,
            height: isFullscreen
              ? "calc(100vh - 56px)"
              : "max(760px, calc(100vh - 240px))",
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

        {/* 悬停浮动卡片 (Hover Tooltip) */}
        {hoveredNode && (
          <div
            style={{
              position: "absolute",
              bottom: 16,
              left: 16,
              padding: "10px 14px",
              background: "rgba(15, 23, 42, 0.9)",
              backdropFilter: "blur(8px)",
              border: "1px solid #334155",
              borderRadius: 8,
              color: "#e2e8f0",
              maxWidth: 320,
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              pointerEvents: "none",
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
                  boxShadow: `0 0 8px ${hoveredNode.targetColor}`,
                }}
              />
              <Text strong style={{ color: "#fff", fontSize: 13 }}>
                {hoveredNode.name}
              </Text>
            </Flex>
            <Flex gap={8} align="center">
              <Tag color="geekblue" style={{ margin: 0, fontSize: 11 }}>
                {TYPE_CONFIG[hoveredNode.type]?.label || hoveredNode.type}
              </Tag>
              <Text type="secondary" style={{ fontSize: 12, color: "#94a3b8" }}>
                连结数: {hoveredNode.connections || 0}
              </Text>
            </Flex>
          </div>
        )}

        {/* 空数据或加载蒙层 */}
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
                  boxShadow: `0 0 8px ${selectedNode.targetColor}`,
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
