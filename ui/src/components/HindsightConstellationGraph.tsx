/**
 * Hindsight 官方原生 Constellation（记忆星图）Canvas 引擎组件
 *
 * 核心技术与视觉规范：
 * 1. 纯 HTML5 Canvas 60fps 原生流式渲染，高分屏自适应 (DPR)；
 * 2. 官方原生配色：World (#8b5cf6)、Experience (#ec4899)、Observation (#6366f1)、Entity (#0ea5e9) 等；
 * 3. 动态物理与有机呼吸：时间步 z 驱动的星体脉动微动与星芒扩散；
 * 4. 流光二次贝塞尔连线：记忆节点间微弯曲连线，能量光子 (Photons) 沿曲线飞行且带 shadowBlur 霓虹光晕；
 * 5. 凸包算法聚类外圈 (Convex Hull)：Monotone Chain 算法计算聚类凸包，绘制圆角柔光包络与星团胶囊标签；
 * 6. 空间网格碰撞检测与标签剔除：智能空间哈希网格，彻底消灭密集节点标签遮挡；
 * 7. 阻尼惯性插值相机：平滑平移、鼠标焦点滚轮缩放、节点悬停邻接点高亮与点击回调。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Tooltip, Typography, theme as antTheme } from "antd";
import { useSafeTheme } from "../theme/ThemeProvider.js";
import {
  AimOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";

const { Text } = Typography;

export interface ConstellationNode {
  id: string;
  label?: string;
  group?: string; // "world" | "experience" | "observation" | "entity" | "document" | "tag" | "concept" | string
  color?: string;
  size?: number;
  val?: number;
  linkCount?: number;
  raw?: unknown;
}

export interface ConstellationLink {
  source: string;
  target: string;
  type?: "semantic" | "temporal" | "entity" | "causal" | "wikilink" | "tag" | string;
  color?: string;
  weight?: number;
}

export interface ConstellationData {
  nodes: ConstellationNode[];
  links: ConstellationLink[];
}

export interface HindsightConstellationGraphProps {
  data: ConstellationData | null;
  height?: number | string;
  onNodeClick?: (node: ConstellationNode) => void;
  nodeSizeFn?: (node: ConstellationNode) => number;
  clusterKeyFn?: (node: ConstellationNode) => string | null;
  clusterColorFn?: (clusterKey: string) => string;
  clusterLabelFn?: (clusterKey: string) => string;
  interactive?: boolean;
  showControls?: boolean;
  showHUD?: boolean;
  showLegend?: boolean;
  emptyMessage?: string;
}

/** Hindsight 官方原生调色板 */
export const HINDSIGHT_PALETTE: Record<string, string> = {
  world: "#8b5cf6",        // 紫罗兰：客观世界事实
  experience: "#ec4899",   // 蔷薇粉：智能体经历与执行
  observation: "#6366f1",  // 靛蓝：观察与反思
  entity: "#0ea5e9",       // 天蓝：实体与概念
  semantic: "#0074d9",     // 经典蓝：语义关联
  temporal: "#009296",     // 青碧色：时序关联
  causal: "#8b5cf6",       // 紫罗兰：因果关联
  default: "#0074d9",
};

/** 简易字符串 Hash 生成伪随机数（保持布局确定性） */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i) | 0;
  }
  return hash;
}

/** 颜色转 RGBA */
function hexToRgba(hex: string, alpha: number): string {
  let c = hex.replace("#", "");
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  const num = parseInt(c, 16);
  if (isNaN(num)) return `rgba(14, 165, 233, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 2D 单调链（Monotone Chain）凸包算法 */
function computeConvexHull(points: [number, number][]): [number, number][] {
  if (points.length <= 2) return points.slice();
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: [number, number][] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: [number, number][] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

interface PreparedNode {
  node: ConstellationNode;
  wx: number; // 世界坐标 X
  wy: number; // 世界坐标 Y
  color: string;
  linkCount: number;
  phase: number;
}

interface PreparedLink {
  sourceIndex: number;
  targetIndex: number;
  color: string;
  type: string;
}

interface PreparedCluster {
  key: string;
  label: string;
  color: string;
  memberIndices: number[];
}

export function HindsightConstellationGraph({
  data,
  height = 520,
  onNodeClick,
  nodeSizeFn,
  clusterKeyFn,
  clusterColorFn,
  clusterLabelFn,
  interactive = true,
  showControls = true,
  showHUD = true,
  showLegend = true,
  emptyMessage = "暂无记忆星图数据",
}: HindsightConstellationGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameId = useRef<number>(0);

  // 检测暗黑模式
  const { token } = antTheme.useToken();
  const safeTheme = useSafeTheme();
  const isDark = safeTheme === "dark" || Boolean(token.colorBgContainer && (token.colorBgContainer.startsWith("#1") || token.colorBgContainer.startsWith("#0") || token.colorBgContainer.includes("dark")));

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(false);
  isPausedRef.current = isPaused;

  // 状态指针与相机 Transform
  const animTimeRef = useRef<{ seconds: number; lastFrameMs: number }>({ seconds: 0, lastFrameMs: 0 });
  const cameraRef = useRef({
    panX: 0,
    panY: 0,
    zoom: 0.85,
    targetPanX: 0,
    targetPanY: 0,
    targetZoom: 0.85,
    mouseX: -1,
    mouseY: -1,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    panStartX: 0,
    panStartY: 0,
    hoverIndex: -1,
    width: 0,
    height: 0,
    dpr: 1,
  });

  // 预处理节点、连线与聚类数据
  const { preparedNodes, preparedLinks, linksByNode, clusters } = useMemo(() => {
    if (!data || !data.nodes || data.nodes.length === 0) {
      return { preparedNodes: [], preparedLinks: [], linksByNode: new Map<number, number[]>(), clusters: [] };
    }

    const idToIndex = new Map<string, number>();
    data.nodes.forEach((n, idx) => idToIndex.set(n.id, idx));

    // 统计各节点连接度
    const degrees = new Map<string, number>();
    for (const link of data.links || []) {
      degrees.set(link.source, (degrees.get(link.source) || 0) + 1);
      degrees.set(link.target, (degrees.get(link.target) || 0) + 1);
    }

    // 聚类提取
    const clusterMap = new Map<string, number[]>();
    if (clusterKeyFn) {
      data.nodes.forEach((n, idx) => {
        const k = clusterKeyFn(n);
        if (k) {
          const list = clusterMap.get(k) || [];
          list.push(idx);
          clusterMap.set(k, list);
        }
      });
    }

    const clusterKeys = Array.from(clusterMap.keys());
    const clusterPositions = new Map<string, { cx: number; cy: number; r: number }>();
    const nodeCount = data.nodes.length;
    const spreadRadius = 55 * Math.sqrt(Math.max(nodeCount, 1));

    clusterKeys.forEach((key, kIdx) => {
      const angle = (kIdx / Math.max(clusterKeys.length, 1)) * Math.PI * 2;
      const count = clusterMap.get(key)?.length || 1;
      const r = 26 + 18 * Math.sqrt(count);
      clusterPositions.set(key, {
        cx: Math.cos(angle) * spreadRadius,
        cy: Math.sin(angle) * spreadRadius,
        r,
      });
    });

    // 节点位置初始化
    const nodes: PreparedNode[] = data.nodes.map((node, idx) => {
      const hash = Math.abs(hashString(node.id));
      const groupKey = clusterKeyFn ? clusterKeyFn(node) : null;
      const clusterPos = groupKey ? clusterPositions.get(groupKey) : null;
      let wx = 0;
      let wy = 0;

      if (clusterPos && groupKey) {
        const members = clusterMap.get(groupKey) || [];
        const inIdx = members.indexOf(idx);
        const subAngle = (inIdx / Math.max(members.length, 1)) * Math.PI * 2 + ((hash % 100) / 100) * 0.6;
        const subR = clusterPos.r * (0.2 + (hash % 1000) / 1000 * 0.7);
        wx = clusterPos.cx + Math.cos(subAngle) * subR;
        wy = clusterPos.cy + Math.sin(subAngle) * subR;
      } else {
        const angle = (idx / nodeCount) * Math.PI * 2 + ((hash % 100) / 100) * 0.5;
        const r = (0.35 + 0.65 * ((hash % 1000) / 1000)) * (32 * Math.sqrt(nodeCount));
        wx = Math.cos(angle) * r + ((hash % 200) - 100) * 0.5;
        wy = Math.sin(angle) * r + (((hash >> 8) % 200) - 100) * 0.5;
      }

      // 颜色映射
      let color = node.color;
      if (!color) {
        const g = node.group || "default";
        color = HINDSIGHT_PALETTE[g] || HINDSIGHT_PALETTE.default;
      }

      return {
        node,
        wx,
        wy,
        color,
        linkCount: degrees.get(node.id) || 0,
        phase: ((hash % 1000) / 1000) * Math.PI * 2,
      };
    });

    // 连线构建
    const links: PreparedLink[] = [];
    const adjMap = new Map<number, number[]>();

    (data.links || []).forEach((link) => {
      const sIdx = idToIndex.get(link.source);
      const tIdx = idToIndex.get(link.target);
      if (sIdx === undefined || tIdx === undefined) return;

      const linkType = link.type || "semantic";
      const linkColor = link.color || HINDSIGHT_PALETTE[linkType] || HINDSIGHT_PALETTE.default;
      const linkIdx = links.length;

      links.push({
        sourceIndex: sIdx,
        targetIndex: tIdx,
        color: linkColor,
        type: linkType,
      });

      if (!adjMap.has(sIdx)) adjMap.set(sIdx, []);
      if (!adjMap.has(tIdx)) adjMap.set(tIdx, []);
      adjMap.get(sIdx)!.push(linkIdx);
      adjMap.get(tIdx)!.push(linkIdx);
    });

    const preparedClusters: PreparedCluster[] = clusterKeys.map((k) => ({
      key: k,
      label: clusterLabelFn ? clusterLabelFn(k) : k,
      color: clusterColorFn ? clusterColorFn(k) : HINDSIGHT_PALETTE.entity,
      memberIndices: clusterMap.get(k) || [],
    }));

    return {
      preparedNodes: nodes,
      preparedLinks: links,
      linksByNode: adjMap,
      clusters: preparedClusters,
    };
  }, [data, clusterKeyFn, clusterColorFn, clusterLabelFn]);

  // 自适应全览重置
  const fitView = useCallback(() => {
    if (preparedNodes.length === 0) return;
    const cam = cameraRef.current;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    preparedNodes.forEach((n) => {
      if (n.wx < minX) minX = n.wx;
      if (n.wx > maxX) maxX = n.wx;
      if (n.wy < minY) minY = n.wy;
      if (n.wy > maxY) maxY = n.wy;
    });

    const spanX = Math.max(maxX - minX, 100);
    const spanY = Math.max(maxY - minY, 100);
    const padding = 120;
    const availW = Math.max(cam.width - padding * 2, 200);
    const availH = Math.max(cam.height - padding * 2, 200);

    const fitZoom = Math.min(availW / spanX, availH / spanY, 2.0);
    cam.targetZoom = Math.max(0.2, fitZoom);
    cam.targetPanX = -(minX + maxX) / 2 * cam.targetZoom;
    cam.targetPanY = -(minY + maxY) / 2 * cam.targetZoom;
  }, [preparedNodes]);

  // Canvas 绘制主循环
  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cam = cameraRef.current;

    // 相机阻尼插值更新 (0.12 lerp)
    cam.panX += (cam.targetPanX - cam.panX) * 0.12;
    cam.panY += (cam.targetPanY - cam.panY) * 0.12;
    cam.zoom += (cam.targetZoom - cam.zoom) * 0.12;

    const { width: W, height: H, dpr, zoom, panX, panY, mouseX, mouseY, hoverIndex } = cam;
    const centerX = W / 2 + panX;
    const centerY = H / 2 + panY;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    // 背景色（暗黑为深邃星系 #09090b，浅色为 #f8fafc）
    ctx.fillStyle = isDark ? "#09090b" : "#f8fafc";
    ctx.fillRect(0, 0, W, H);

    // 细微深空背景星尘网格点
    ctx.fillStyle = isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)";
    const dotGap = 40 * Math.max(0.5, Math.min(zoom, 1.5));
    const offsetX = (centerX % dotGap + dotGap) % dotGap;
    const offsetY = (centerY % dotGap + dotGap) % dotGap;
    for (let x = offsetX; x < W; x += dotGap) {
      for (let y = offsetY; y < H; y += dotGap) {
        ctx.fillRect(x, y, 1.2, 1.2);
      }
    }

    // 时间推进 (秒)
    const nowMs = performance.now();
    const anim = animTimeRef.current;
    if (!isPausedRef.current && anim.lastFrameMs > 0) {
      anim.seconds += (nowMs - anim.lastFrameMs) / 1000;
    }
    anim.lastFrameMs = nowMs;
    const z = anim.seconds;

    // 计算各节点当前屏幕投影坐标（包含微动）
    const screenX = new Float32Array(preparedNodes.length);
    const screenY = new Float32Array(preparedNodes.length);
    const isVisible = new Uint8Array(preparedNodes.length);

    for (let i = 0; i < preparedNodes.length; i++) {
      const node = preparedNodes[i];
      // 有机呼吸物理微动 (16px 振幅)
      const swayX = 14 * Math.sin(0.6 * z + node.phase);
      const swayY = 14 * Math.cos(0.5 * z + 1.3 * node.phase);
      const sx = centerX + (node.wx + swayX) * zoom;
      const sy = centerY + (node.wy + swayY) * zoom;
      screenX[i] = sx;
      screenY[i] = sy;
      isVisible[i] = sx > -80 && sx < W + 80 && sy > -80 && sy < H + 80 ? 1 : 0;
    }

    // 鼠标悬停命中检测
    if (mouseX >= 0 && !cam.isDragging && interactive) {
      let closestDist = zoom > 1.5 ? 80 : 36;
      let foundIdx = -1;
      for (let i = 0; i < preparedNodes.length; i++) {
        if (!isVisible[i]) continue;
        const dx = mouseX - screenX[i];
        const dy = mouseY - screenY[i];
        const dist = Math.hypot(dx, dy);
        if (dist < closestDist) {
          closestDist = dist;
          foundIdx = i;
        }
      }
      cam.hoverIndex = foundIdx;
    }

    // 活跃连线集合
    const activeLinkIndices = new Set<number>();
    if (hoverIndex >= 0) {
      const neighborLinks = linksByNode.get(hoverIndex) || [];
      neighborLinks.forEach((lIdx) => activeLinkIndices.add(lIdx));
    }

    // 1. 绘制凸包聚类轮廓与背景 (Convex Hull)
    if (clusters.length > 0) {
      ctx.save();
      ctx.lineJoin = "round";

      for (const cluster of clusters) {
        const pts: [number, number][] = [];
        cluster.memberIndices.forEach((mIdx) => {
          if (mIdx < screenX.length && isVisible[mIdx]) {
            pts.push([screenX[mIdx], screenY[mIdx]]);
          }
        });

        if (pts.length === 0) continue;

        let avgX = 0;
        let avgY = 0;
        pts.forEach(([px, py]) => {
          avgX += px;
          avgY += py;
        });
        avgX /= pts.length;
        avgY /= pts.length;

        ctx.fillStyle = hexToRgba(cluster.color, isDark ? 0.08 : 0.06);
        ctx.strokeStyle = hexToRgba(cluster.color, 0.35);
        ctx.lineWidth = 1.2;

        ctx.beginPath();
        if (pts.length < 3) {
          let maxR = 30;
          pts.forEach(([px, py]) => {
            maxR = Math.max(maxR, Math.hypot(px - avgX, py - avgY) + 32);
          });
          ctx.arc(avgX, avgY, maxR, 0, Math.PI * 2);
        } else {
          const hull = computeConvexHull(pts);
          for (let pIdx = 0; pIdx < hull.length; pIdx++) {
            const [hx, hy] = hull[pIdx];
            const dx = hx - avgX;
            const dy = hy - avgY;
            const len = Math.hypot(dx, dy) || 1;
            const padX = hx + (dx / len) * 28;
            const padY = hy + (dy / len) * 28;
            if (pIdx === 0) ctx.moveTo(padX, padY);
            else ctx.lineTo(padX, padY);
          }
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();

        // 绘制聚类胶囊标签
        if (cluster.label && zoom > 0.35) {
          ctx.font = "600 11px system-ui, sans-serif";
          const textW = ctx.measureText(cluster.label).width;
          let topY = avgY;
          pts.forEach(([, py]) => {
            topY = Math.min(topY, py);
          });
          const tagY = topY - 38;
          const tagW = textW + 16;
          ctx.fillStyle = cluster.color;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(avgX - tagW / 2, tagY - 9, tagW, 18, 9);
          else ctx.rect(avgX - tagW / 2, tagY - 9, tagW, 18);
          ctx.fill();

          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(cluster.label, avgX, tagY);
        }
      }
      ctx.restore();
    }

    // 2. 绘制连线 (二次贝塞尔流光连线)
    let renderedLinksCount = 0;
    if (hoverIndex >= 0 && activeLinkIndices.size > 0) {
      // 悬停模式：高亮相邻连线与能量流光微粒
      for (const lIdx of activeLinkIndices) {
        const link = preparedLinks[lIdx];
        if (!link) continue;
        const ax = screenX[link.sourceIndex];
        const ay = screenY[link.sourceIndex];
        const bx = screenX[link.targetIndex];
        const by = screenY[link.targetIndex];

        ctx.strokeStyle = link.color;
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 1.6;

        // 微弯贝塞尔控制点
        const cX = (ax + bx) / 2 + (by - ay) * 0.08;
        const cY = (ay + by) / 2 - (bx - ax) * 0.08;

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(cX, cY, bx, by);
        ctx.stroke();

        // 飞跃流动光子 (Photon)
        const isForward = link.sourceIndex === hoverIndex;
        const travel = (0.24 * z + (lIdx % 13) / 13) % 1;
        const t = isForward ? travel : 1 - travel;
        const h = 1 - t;
        const px = h * h * ax + 2 * h * t * cX + t * t * bx;
        const py = h * h * ay + 2 * h * t * cY + t * t * by;

        ctx.globalAlpha = 0.95;
        ctx.fillStyle = link.color;
        ctx.shadowColor = link.color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        renderedLinksCount++;
      }
      ctx.globalAlpha = 1;
    } else {
      // 默认全景连线
      const baseAlpha = (0.08 + Math.min(0.04 * zoom, 0.1)) * (1 + 0.15 * Math.sin(0.6 * z));
      ctx.lineWidth = 0.6;
      for (const link of preparedLinks) {
        if (renderedLinksCount >= 3000) break;
        const ax = screenX[link.sourceIndex];
        const ay = screenY[link.sourceIndex];
        const bx = screenX[link.targetIndex];
        const by = screenY[link.targetIndex];

        if (
          (ax < -40 && bx < -40) ||
          (ax > W + 40 && bx > W + 40) ||
          (ay < -40 && by < -40) ||
          (ay > H + 40 && by > H + 40)
        )
          continue;

        ctx.strokeStyle = link.color;
        ctx.globalAlpha = baseAlpha;
        const cX = (ax + bx) / 2 + (by - ay) * 0.08;
        const cY = (ay + by) / 2 - (bx - ax) * 0.08;

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(cX, cY, bx, by);
        ctx.stroke();
        renderedLinksCount++;
      }
      ctx.globalAlpha = 1;
    }

    // 3. 空间哈希防重叠标签网格
    const labelGridCell = zoom > 1.2 ? 30 : 70;
    const occupiedCells = new Set<string>();
    const canPlaceLabel = (lx: number, ly: number, lw: number, lh: number) => {
      const minX = Math.floor(lx / labelGridCell);
      const maxX = Math.floor((lx + lw) / labelGridCell);
      const minY = Math.floor(ly / labelGridCell);
      const maxY = Math.floor((ly + lh) / labelGridCell);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          if (occupiedCells.has(`${x},${y}`)) return false;
        }
      }
      return true;
    };
    const markOccupied = (lx: number, ly: number, lw: number, lh: number) => {
      const minX = Math.floor(lx / labelGridCell);
      const maxX = Math.floor((lx + lw) / labelGridCell);
      const minY = Math.floor(ly / labelGridCell);
      const maxY = Math.floor((ly + lh) / labelGridCell);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          occupiedCells.add(`${x},${y}`);
        }
      }
    };

    // 4. 绘制星体节点
    for (let i = 0; i < preparedNodes.length; i++) {
      if (!isVisible[i]) continue;
      const node = preparedNodes[i];
      const sx = screenX[i];
      const sy = screenY[i];
      const isHovered = i === hoverIndex;
      const isNeighbor = activeLinkIndices.size > 0 && (linksByNode.get(i) || []).some((l) => activeLinkIndices.has(l));

      const rawBase = nodeSizeFn ? nodeSizeFn(node.node) : 3.0 + Math.min(0.2 * node.linkCount, 3.5);
      const pulse = 1 + 0.13 * Math.sin(1.05 * z + node.phase);
      const radius = Math.max(1.8, rawBase * pulse * Math.min(zoom, 2.2));

      // 节点微光投影
      if (isHovered || isNeighbor) {
        ctx.shadowColor = node.color;
        ctx.shadowBlur = isHovered ? 22 : 12;
      }

      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.globalAlpha = isHovered ? 1.0 : isNeighbor ? 0.95 : hoverIndex >= 0 ? 0.15 : 0.85;
      ctx.fill();
      ctx.shadowBlur = 0;

      // 高连接度星环光晕
      if (node.linkCount > 3 && !isHovered && hoverIndex < 0) {
        const ringAlpha = (0.06 + Math.min(0.005 * node.linkCount, 0.08)) * (1 + 0.25 * Math.sin(0.9 * z + 1.7 * node.phase));
        ctx.beginPath();
        ctx.arc(sx, sy, radius * 2.2, 0, Math.PI * 2);
        ctx.fillStyle = node.color;
        ctx.globalAlpha = ringAlpha;
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 节点文本注记 (智能避障)
      const labelText = node.node.label || node.node.id;
      if (labelText) {
        ctx.font = isHovered ? "bold 12px system-ui, sans-serif" : "11px system-ui, sans-serif";
        const textWidth = Math.min(180, ctx.measureText(labelText).width);
        const labelX = sx + radius + 6;
        const labelY = sy - 6;

        if (isHovered) {
          // 悬停高亮注记泡泡
          ctx.fillStyle = isDark ? "rgba(24, 24, 27, 0.9)" : "rgba(255, 255, 255, 0.95)";
          ctx.strokeStyle = node.color;
          ctx.lineWidth = 1;
          const padW = textWidth + 14;
          const padH = 20;
          if (ctx.roundRect) ctx.roundRect(labelX - 4, labelY - 14, padW, padH, 4);
          else ctx.rect(labelX - 4, labelY - 14, padW, padH);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = isDark ? "#ffffff" : "#09090b";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(labelText, labelX + 3, labelY - 4);
        } else if (zoom > 0.75 || isNeighbor) {
          if (canPlaceLabel(labelX, labelY - 10, textWidth, 16)) {
            markOccupied(labelX, labelY - 10, textWidth, 16);
            ctx.fillStyle = isDark ? "#a1a1aa" : "#475569";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(labelText, labelX, labelY);
          }
        }
      }
    }

    ctx.restore();

    // 循环执行
    animationFrameId.current = requestAnimationFrame(renderFrame);
  }, [preparedNodes, preparedLinks, linksByNode, clusters, isDark, interactive, nodeSizeFn]);

  // 容器大小测量与 ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(rect.width, 200);
      const h = Math.max(typeof height === "number" ? height : rect.height, 200);

      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      cameraRef.current.width = w;
      cameraRef.current.height = h;
      cameraRef.current.dpr = dpr;
    };

    updateSize();
    fitView();

    const ro = new ResizeObserver(updateSize);
    ro.observe(container);

    return () => ro.disconnect();
  }, [height, fitView]);

  // 启动渲染循环
  useEffect(() => {
    animationFrameId.current = requestAnimationFrame(renderFrame);
    return () => {
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
    };
  }, [renderFrame]);

  // 鼠标交互事件监听
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    const cam = cameraRef.current;
    cam.isDragging = true;
    cam.dragStartX = e.clientX;
    cam.dragStartY = e.clientY;
    cam.panStartX = cam.targetPanX;
    cam.panStartY = cam.targetPanY;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cam = cameraRef.current;
    cam.mouseX = e.clientX - rect.left;
    cam.mouseY = e.clientY - rect.top;

    if (cam.isDragging && interactive) {
      const dx = e.clientX - cam.dragStartX;
      const dy = e.clientY - cam.dragStartY;
      cam.targetPanX = cam.panStartX + dx;
      cam.targetPanY = cam.panStartY + dy;
    }
  };

  const handleMouseUp = () => {
    const cam = cameraRef.current;
    cam.isDragging = false;
  };

  const handleMouseLeave = () => {
    const cam = cameraRef.current;
    cam.isDragging = false;
    cam.mouseX = -1;
    cam.mouseY = -1;
    cam.hoverIndex = -1;
  };

  const handleClick = () => {
    const cam = cameraRef.current;
    if (cam.hoverIndex >= 0 && preparedNodes[cam.hoverIndex]) {
      onNodeClick?.(preparedNodes[cam.hoverIndex].node);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onNativeWheel = (e: WheelEvent) => {
      if (!interactive) return;
      if (e.cancelable) {
        e.preventDefault();
      }
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const cam = cameraRef.current;
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const newZoom = Math.max(0.1, Math.min(4.0, cam.targetZoom * factor));

      // 围绕鼠标光标平滑缩放
      const currentW = cam.width / 2 + cam.targetPanX;
      const currentH = cam.height / 2 + cam.targetPanY;
      cam.targetPanX = mouseX - (mouseX - currentW) * (newZoom / cam.targetZoom) - cam.width / 2;
      cam.targetPanY = mouseY - (mouseY - currentH) * (newZoom / cam.targetZoom) - cam.height / 2;
      cam.targetZoom = newZoom;
    };

    canvas.addEventListener("wheel", onNativeWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onNativeWheel);
    };
  }, [interactive]);

  const zoomIn = () => {
    const cam = cameraRef.current;
    cam.targetZoom = Math.min(4.0, cam.targetZoom * 1.25);
  };

  const zoomOut = () => {
    const cam = cameraRef.current;
    cam.targetZoom = Math.max(0.1, cam.targetZoom * 0.8);
  };

  const togglePause = () => {
    setIsPaused((prev) => !prev);
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (!isFullscreen) {
      if (container.requestFullscreen) container.requestFullscreen();
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const hasNodes = preparedNodes.length > 0;

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: typeof height === "number" ? `${height}px` : height,
        borderRadius: 12,
        overflow: "hidden",
        border: `1px solid ${token.colorBorderSecondary}`,
        background: isDark ? token.colorBgLayout : token.colorBgContainer,
      }}
    >
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          cursor: cameraRef.current.hoverIndex >= 0 ? "pointer" : "grab",
        }}
      />

      {/* 无数据空状态提示 */}
      {!hasNodes && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <AimOutlined style={{ fontSize: 36, color: token.colorTextTertiary, marginBottom: 12, opacity: 0.6 }} />
          <Text style={{ color: token.colorTextSecondary, fontSize: 13 }}>{emptyMessage}</Text>
        </div>
      )}

      {/* 左上角 HUD 统计信息 */}
      {showHUD && hasNodes && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: isDark ? "var(--ant-color-bg-elevated)" : "rgba(255, 255, 255, 0.88)",
            backdropFilter: "blur(20px) saturate(180%)",
            padding: "5px 12px",
            borderRadius: 9999,
            border: `1px solid ${isDark ? "var(--ant-color-border-secondary)" : "var(--ant-color-border-secondary)"}`,
            boxShadow: isDark ? "0 4px 16px -2px rgba(0, 0, 0, 0.3)" : "0 4px 16px -2px rgba(0, 0, 0, 0.05)",
            fontSize: 12,
            fontFamily: "Inter, -apple-system, sans-serif",
            color: isDark ? "var(--ant-color-text)" : "var(--ant-color-text-secondary, #414753)",
            pointerEvents: "none",
          }}
        >
          <span>节点: {preparedNodes.length}</span>
          <span>连线: {preparedLinks.length}</span>
          {clusters.length > 0 && <span>星团: {clusters.length}</span>}
        </div>
      )}

      {/* 右上角悬浮控制器 */}
      {showControls && (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            zIndex: 10,
          }}
        >
          <Tooltip title="自适应居中全览" placement="left">
            <Button
              shape="circle"
              icon={<AimOutlined style={{ fontSize: 15 }} />}
              onClick={fitView}
              style={{
                width: 34,
                height: 34,
                minWidth: 34,
                minHeight: 34,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: isDark ? "var(--ant-color-bg-elevated)" : "rgba(255, 255, 255, 0.92)",
                backdropFilter: "blur(20px) saturate(180%)",
                border: `1px solid var(--ant-color-border-secondary)`,
                boxShadow: isDark ? "0 2px 10px rgba(0, 0, 0, 0.3)" : "0 2px 10px rgba(0, 0, 0, 0.06)",
                color: isDark ? "var(--ant-color-text)" : "inherit",
              }}
            />
          </Tooltip>
          <Tooltip title="放大" placement="left">
            <Button
              shape="circle"
              icon={<ZoomInOutlined style={{ fontSize: 15 }} />}
              onClick={zoomIn}
              style={{
                width: 34,
                height: 34,
                minWidth: 34,
                minHeight: 34,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: isDark ? "var(--ant-color-bg-elevated)" : "rgba(255, 255, 255, 0.92)",
                backdropFilter: "blur(20px) saturate(180%)",
                border: `1px solid var(--ant-color-border-secondary)`,
                boxShadow: isDark ? "0 2px 10px rgba(0, 0, 0, 0.3)" : "0 2px 10px rgba(0, 0, 0, 0.06)",
                color: isDark ? "var(--ant-color-text)" : "inherit",
              }}
            />
          </Tooltip>
          <Tooltip title="缩小" placement="left">
            <Button
              shape="circle"
              icon={<ZoomOutOutlined style={{ fontSize: 15 }} />}
              onClick={zoomOut}
              style={{
                width: 34,
                height: 34,
                minWidth: 34,
                minHeight: 34,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: isDark ? "var(--ant-color-bg-elevated)" : "rgba(255, 255, 255, 0.92)",
                backdropFilter: "blur(20px) saturate(180%)",
                border: `1px solid var(--ant-color-border-secondary)`,
                boxShadow: isDark ? "0 2px 10px rgba(0, 0, 0, 0.3)" : "0 2px 10px rgba(0, 0, 0, 0.06)",
                color: isDark ? "var(--ant-color-text)" : "inherit",
              }}
            />
          </Tooltip>
          <Tooltip title={isPaused ? "恢复有机呼吸" : "暂停微动"} placement="left">
            <Button
              shape="circle"
              icon={isPaused ? <PlayCircleOutlined style={{ fontSize: 15 }} /> : <PauseOutlined style={{ fontSize: 15 }} />}
              onClick={togglePause}
              style={{
                width: 34,
                height: 34,
                minWidth: 34,
                minHeight: 34,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: isDark ? "var(--ant-color-bg-elevated)" : "rgba(255, 255, 255, 0.92)",
                backdropFilter: "blur(20px) saturate(180%)",
                border: `1px solid var(--ant-color-border-secondary)`,
                boxShadow: isDark ? "0 2px 10px rgba(0, 0, 0, 0.3)" : "0 2px 10px rgba(0, 0, 0, 0.06)",
                color: isDark ? "var(--ant-color-text)" : "inherit",
              }}
            />
          </Tooltip>
          <Tooltip title={isFullscreen ? "退出全屏" : "全屏沉浸"} placement="left">
            <Button
              shape="circle"
              icon={isFullscreen ? <FullscreenExitOutlined style={{ fontSize: 15 }} /> : <FullscreenOutlined style={{ fontSize: 15 }} />}
              onClick={toggleFullscreen}
              style={{
                width: 34,
                height: 34,
                minWidth: 34,
                minHeight: 34,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: isDark ? "var(--ant-color-bg-elevated)" : "rgba(255, 255, 255, 0.92)",
                backdropFilter: "blur(20px) saturate(180%)",
                border: `1px solid var(--ant-color-border-secondary)`,
                boxShadow: isDark ? "0 2px 10px rgba(0, 0, 0, 0.3)" : "0 2px 10px rgba(0, 0, 0, 0.06)",
                color: isDark ? "var(--ant-color-text)" : "inherit",
              }}
            />
          </Tooltip>
        </div>
      )}

      {/* 底部连线类型图例 */}
      {showLegend && hasNodes && (
        <div
          style={{
            position: "absolute",
            bottom: 12,
            right: 12,
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: isDark ? "var(--ant-color-bg-elevated)" : "rgba(255, 255, 255, 0.88)",
            backdropFilter: "blur(20px) saturate(180%)",
            padding: "5px 14px",
            borderRadius: 9999,
            border: `1px solid ${isDark ? "var(--ant-color-border-secondary)" : "var(--ant-color-border-secondary)"}`,
            boxShadow: isDark ? "0 4px 16px -2px rgba(0, 0, 0, 0.3)" : "0 4px 16px -2px rgba(0, 0, 0, 0.05)",
            fontSize: 12,
            color: isDark ? "var(--ant-color-text)" : "var(--ant-color-text-secondary, #414753)",
            pointerEvents: "none",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: HINDSIGHT_PALETTE.world }} />
            World
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: HINDSIGHT_PALETTE.experience }} />
            Experience
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: HINDSIGHT_PALETTE.observation }} />
            Observation
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: HINDSIGHT_PALETTE.entity }} />
            Entity
          </span>
        </div>
      )}
    </div>
  );
}
