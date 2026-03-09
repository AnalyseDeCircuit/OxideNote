/**
 * GraphView — 知识图谱可视化面板（含时间轴）
 *
 * 使用 force-graph 库渲染笔记之间的 WikiLink 关系网络。
 * 采用力导向布局算法，节点代表笔记，连边代表引用关系。
 *
 * 时间轴特色：
 *   · 底部时间轴滑块 → 拖动可看到知识随时间生长
 *   · 节点颜色"氧化度" → 越旧越深（古铜色），越新越亮（accent 色）
 *   · 拖动滑块时图谱节点动态显现/消失
 *
 * 交互特性：
 *   · 点击节点 → 打开对应笔记
 *   · 鼠标悬停 → 高亮关联节点与连边
 *   · 缩放/平移 → 自由探索大型图谱
 *   · 全屏覆盖层 → 按 Esc 或点击关闭按钮退出
 */

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import ForceGraph from 'force-graph';

// force-graph 导出类型为类构造器，运行时为工厂函数
interface ForceGraphInstance {
  width(w: number): ForceGraphInstance;
  height(h: number): ForceGraphInstance;
  graphData(data: { nodes: object[]; links: object[] }): ForceGraphInstance;
  nodeLabel(fn: (n: object) => string): ForceGraphInstance;
  nodeColor(fn: (n: object) => string): ForceGraphInstance;
  nodeRelSize(s: number): ForceGraphInstance;
  linkColor(fn: (link: object) => string): ForceGraphInstance;
  linkWidth(w: number | ((link: object) => number)): ForceGraphInstance;
  linkDirectionalArrowLength(l: number): ForceGraphInstance;
  linkDirectionalArrowRelPos(p: number): ForceGraphInstance;
  onNodeClick(fn: (n: object) => void): ForceGraphInstance;
  onNodeHover(fn: (n: object | null) => void): ForceGraphInstance;
  backgroundColor(c: string): ForceGraphInstance;
  nodeCanvasObject(fn: (n: object, ctx: CanvasRenderingContext2D, s: number) => void): ForceGraphInstance;
  nodeCanvasObjectMode(fn: () => string): ForceGraphInstance;
  d3Force(name: string, ...args: unknown[]): { strength?(v: number): void; distance?(v: number): void } | undefined;
  d3AlphaDecay(v: number): ForceGraphInstance;
  onEngineStop(fn: () => void): ForceGraphInstance;
  zoomToFit(duration?: number, padding?: number): ForceGraphInstance;
  zoom(level?: number, duration?: number): any;
  onZoom(fn: (transform: { k: number; x: number; y: number }) => void): ForceGraphInstance;
  _destructor?(): void;
}
type ForceGraphFactory = (el: HTMLElement) => ForceGraphInstance;
const createForceGraph = ForceGraph as unknown as () => ForceGraphFactory;
import { getGraphData, getLocalGraph, type GraphData, type GraphNode } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { useUIStore } from '@/store/uiStore';
import { useTranslation } from 'react-i18next';
import { X, Clock, Boxes, Globe, Focus, ZoomIn, ZoomOut, Maximize2, RotateCw } from 'lucide-react';

// ── 时间轴工具函数 ──────────────────────────────────────────

/** Parse ISO 8601 string to unix timestamp (ms). Returns 0 for null/invalid. */
function parseTs(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Linearly interpolate between two hex colors. t ∈ [0,1] */
function lerpColor(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const r = clamp(r1 + (r2 - r1) * t);
  const g = clamp(g1 + (g2 - g1) * t);
  const bl = clamp(b1 + (b2 - b1) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
}

/** 氧化度颜色：从深古铜色（旧）到 accent 色（新） */
const OXIDIZED_COLOR = '#6b3a1f'; // 深铁锈/古铜

// ── Cluster visualization helpers ──────────────────────────

/** Distinct colors for hub-based clusters (up to 15) */
const CLUSTER_PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#5fb7d4',
  '#d4a6c8', '#8cd17d', '#f1ce63', '#a0cbe8', '#bab0ac',
];

/** Minimum connections for a node to qualify as a hub */
const HUB_MIN_DEGREE = 4;

/** Draw a multi-pointed star path on canvas (does not fill/stroke) */
function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  spikes: number, outerR: number, innerR: number
) {
  let rot = -Math.PI / 2; // Start at top
  const step = Math.PI / spikes;
  ctx.beginPath();
  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
    rot += step;
    ctx.lineTo(cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR);
    rot += step;
  }
  ctx.closePath();
}

/** Cluster info for a single node */
interface ClusterEntry {
  color: string;
  degree: number;
  isHub: boolean;
}

/**
 * Compute cluster assignments via multi-source BFS from hub nodes.
 * Hubs = nodes with degree >= HUB_MIN_DEGREE, sorted by degree descending.
 * Each non-hub node is assigned to the nearest hub's cluster.
 */
function computeClusters(
  nodes: GraphNode[],
  links: { source: string; target: string }[]
): Map<string, ClusterEntry> {
  // 1. Compute degree for each node
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n.id, 0);
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }

  // 2. Identify hubs: high-degree nodes
  const sorted = [...degree.entries()].sort((a, b) => b[1] - a[1]);
  const hubs = new Map<string, string>(); // hubId → color
  let ci = 0;
  for (const [id, deg] of sorted) {
    if (deg < HUB_MIN_DEGREE || ci >= CLUSTER_PALETTE.length) break;
    hubs.set(id, CLUSTER_PALETTE[ci++]);
  }

  // 3. Build adjacency list
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const l of links) {
    adj.get(l.source)?.push(l.target);
    adj.get(l.target)?.push(l.source);
  }

  // 4. Multi-source BFS from all hubs — each unvisited node inherits its discoverer's cluster
  const nodeHub = new Map<string, string>();
  for (const hubId of hubs.keys()) nodeHub.set(hubId, hubId);
  const queue = [...hubs.keys()];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const parentHub = nodeHub.get(current)!;
    for (const neighbor of (adj.get(current) ?? [])) {
      if (!nodeHub.has(neighbor)) {
        nodeHub.set(neighbor, parentHub);
        queue.push(neighbor);
      }
    }
  }

  // 5. Build result
  const result = new Map<string, ClusterEntry>();
  const defaultColor = '#a1a1aa';
  for (const [id, deg] of degree) {
    const hubId = nodeHub.get(id);
    result.set(id, {
      color: hubId ? (hubs.get(hubId) ?? defaultColor) : defaultColor,
      degree: deg,
      isHub: hubs.has(id),
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// GraphView 组件
// ═══════════════════════════════════════════════════════════════

export function GraphView() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphInstance>(null);
  const setGraphViewOpen = useUIStore((s) => s.setGraphViewOpen);

  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Refs for stable callbacks in force-graph ──────────────
  // force-graph 的 nodeCanvasObject 回调在初始化时捕获，
  // 通过 ref 使其能读取最新的颜色计算函数和 accent 颜色
  const accentColorRef = useRef('#ea580c');
  const textColorRef = useRef('#f4f4f5');
  const mutedColorRef = useRef('#a1a1aa');
  const borderColorRef = useRef('#27272a');
  const getNodeColorRef = useRef<(node: GraphNode, accent: string) => string>(() => '#ea580c');
  const clusterInfoRef = useRef<Map<string, ClusterEntry>>(new Map());
  const timelineEnabledRef = useRef(false);
  const justCreatedRef = useRef(false);

  // ── 时间轴状态 ────────────────────────────────────────────
  const [timelineEnabled, setTimelineEnabled] = useState(false);
  const [sliderValue, setSliderValue] = useState(100); // 0‥100 百分比

  // ── 缩放级别追踪 ─────────────────────────────────────────
  const [zoomLevel, setZoomLevel] = useState(100);

  // ── 块级节点开关 ─────────────────────────────────────────
  const [includeBlocks, setIncludeBlocks] = useState(false);

  // ── 局部/全局图谱模式 ───────────────────────────────────
  const [localMode, setLocalMode] = useState(false);
  const [localDepth, setLocalDepth] = useState(2);
  const currentNotePath = useNoteStore((s) => s.activeTabPath ?? '');

  // ── 加载图谱数据 ─────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    const loadPromise = localMode && currentNotePath
      ? getLocalGraph(currentNotePath, localDepth)
      : getGraphData(includeBlocks);
    loadPromise
      .then(setGraphData)
      .catch((err) => {
        console.warn('[graph] Failed to load graph data:', err);
        setGraphData({ nodes: [], links: [] });
      })
      .finally(() => setLoading(false));
  }, [includeBlocks, localMode, localDepth, currentNotePath]);

  // ── 计算时间范围 ─────────────────────────────────────────
  const timeRange = useMemo(() => {
    if (!graphData) return { min: 0, max: 0 };
    let min = Infinity;
    let max = -Infinity;
    for (const n of graphData.nodes) {
      const ts = parseTs(n.created_at) || parseTs(n.modified_at);
      if (ts > 0) {
        if (ts < min) min = ts;
        if (ts > max) max = ts;
      }
    }
    if (!Number.isFinite(min)) return { min: 0, max: 0 };
    return { min, max };
  }, [graphData]);

  // ── 当前时间截止线（slider 百分比 → 时间戳） ──────────────
  const cutoffTs = useMemo(() => {
    if (!timelineEnabled || timeRange.max === 0) return Infinity;
    return timeRange.min + (timeRange.max - timeRange.min) * (sliderValue / 100);
  }, [timelineEnabled, sliderValue, timeRange]);

  // ── 按时间过滤后的图谱数据 ───────────────────────────────
  const filteredData = useMemo(() => {
    if (!graphData) return { nodes: [] as GraphNode[], links: [] as { source: string; target: string }[] };
    if (!timelineEnabled || cutoffTs === Infinity) {
      return { nodes: graphData.nodes, links: graphData.links };
    }
    const visibleIds = new Set<string>();
    const nodes = graphData.nodes.filter((n) => {
      const ts = parseTs(n.created_at) || parseTs(n.modified_at);
      // 没有时间戳的节点始终可见
      if (ts === 0 || ts <= cutoffTs) {
        visibleIds.add(n.id);
        return true;
      }
      return false;
    });
    const links = graphData.links.filter(
      (l) => visibleIds.has(l.source) && visibleIds.has(l.target)
    );
    return { nodes, links };
  }, [graphData, timelineEnabled, cutoffTs]);

  // ── 节点颜色计算函数 ─────────────────────────────────────
  const getNodeColor = useCallback(
    (node: GraphNode, accentColor: string): string => {
      if (!timelineEnabled || timeRange.max === timeRange.min) return accentColor;
      const ts = parseTs(node.created_at) || parseTs(node.modified_at);
      if (ts === 0) return accentColor;
      // t=0 → 最旧（氧化色），t=1 → 最新（accent）
      const t = (ts - timeRange.min) / (timeRange.max - timeRange.min);
      return lerpColor(OXIDIZED_COLOR, accentColor, t);
    },
    [timelineEnabled, timeRange]
  );

  // 同步最新的颜色计算函数到 ref，供 force-graph 回调闭包读取
  getNodeColorRef.current = getNodeColor;
  timelineEnabledRef.current = timelineEnabled;

  // ── 计算聚类信息 ─────────────────────────────────────────
  // Cluster info: identifies hubs (high-degree nodes), assigns cluster colors
  const clusterInfo = useMemo(() => {
    if (!filteredData.nodes.length) return new Map<string, ClusterEntry>();
    return computeClusters(filteredData.nodes, filteredData.links);
  }, [filteredData]);
  clusterInfoRef.current = clusterInfo;

  // ── 初始化 force-graph 实例（仅在图谱数据首次可用时创建）──
  // 将创建与数据注入分离，避免时间轴滑动时销毁/重建整个图谱实例
  useEffect(() => {
    if (!containerRef.current || !graphData) return;

    const el = containerRef.current;
    const width = el.clientWidth;
    const height = el.clientHeight;

    // 读取 CSS 主题变量
    const style = getComputedStyle(document.documentElement);
    const accentColor = style.getPropertyValue('--theme-accent').trim() || '#ea580c';
    const textColor = style.getPropertyValue('--theme-text').trim() || '#f4f4f5';
    const mutedColor = style.getPropertyValue('--theme-text-muted').trim() || '#a1a1aa';
    const borderColor = style.getPropertyValue('--theme-border').trim() || '#27272a';

    // 将主题颜色存入 ref，使 nodeCanvasObject 回调始终读取最新值
    accentColorRef.current = accentColor;
    textColorRef.current = textColor;
    mutedColorRef.current = mutedColor;
    borderColorRef.current = borderColor;

    const graph = createForceGraph()(el)
      .width(width)
      .height(height)
      .graphData({
        nodes: filteredData.nodes.map((n) => ({ ...n })),
        links: filteredData.links.map((l) => ({ ...l })),
      })
      .nodeLabel((node: any) => node.title || node.id)
      .nodeColor(() => accentColor)
      .nodeRelSize(5)
      // Link color: match source node's cluster color (with transparency)
      .linkColor((link: any) => {
        if (timelineEnabledRef.current) return borderColorRef.current;
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const cluster = clusterInfoRef.current?.get(sourceId);
        return cluster?.color ? `${cluster.color}55` : borderColorRef.current;
      })
      .linkWidth((link: any) => {
        // Thicker links between hubs
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        const srcHub = clusterInfoRef.current?.get(sourceId)?.isHub;
        const tgtHub = clusterInfoRef.current?.get(targetId)?.isHub;
        return srcHub && tgtHub ? 1.5 : 0.8;
      })
      .linkDirectionalArrowLength(4)
      .linkDirectionalArrowRelPos(1)
      .backgroundColor('transparent')
      .nodeCanvasObjectMode(() => 'replace')
      // Node rendering: hubs as stars, leaves as circles, blocks as diamonds
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const label = node.title || node.id;
        const isBlock = node.is_block === true;
        const cluster = clusterInfoRef.current?.get(node.id);
        const isHub = cluster?.isHub ?? false;
        const deg = cluster?.degree ?? 0;

        // Choose color based on mode
        let color: string;
        if (timelineEnabledRef.current) {
          color = getNodeColorRef.current(node as GraphNode, accentColorRef.current);
        } else {
          color = cluster?.color ?? accentColorRef.current;
        }

        if (isBlock) {
          // Block node: small diamond shape
          const nodeSize = 2.5 / globalScale;
          ctx.beginPath();
          ctx.moveTo(node.x, node.y - nodeSize);
          ctx.lineTo(node.x + nodeSize, node.y);
          ctx.lineTo(node.x, node.y + nodeSize);
          ctx.lineTo(node.x - nodeSize, node.y);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.7;
          ctx.fill();
          ctx.globalAlpha = 1;

          if (globalScale > 2.5) {
            const fontSize = 10 / globalScale;
            ctx.font = `${fontSize}px sans-serif`;
            ctx.fillStyle = mutedColorRef.current;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(label, node.x, node.y + nodeSize + 2 / globalScale);
          }
        } else if (isHub) {
          // Hub node: multi-pointed star
          const baseSize = Math.max(8, 5 + Math.log2(deg + 1) * 3);
          const outerR = baseSize / globalScale;
          const innerR = outerR * 0.45;
          const spikes = Math.min(8, Math.max(5, Math.floor(deg / 3) + 4));

          drawStar(ctx, node.x, node.y, spikes, outerR, innerR);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.25)';
          ctx.lineWidth = 0.8 / globalScale;
          ctx.stroke();

          // Hub label: always visible, bold
          const fontSize = Math.max(11, 13) / globalScale;
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.fillStyle = textColorRef.current;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(label, node.x, node.y + outerR + 2 / globalScale);
        } else {
          // Leaf node: circle, size varies by degree
          const nodeSize = Math.max(2, 1.5 + Math.log2(deg + 1) * 1.2) / globalScale;
          ctx.beginPath();
          ctx.arc(node.x, node.y, nodeSize, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();

          // Label visible at moderate zoom
          if (globalScale > 0.7) {
            const fontSize = 10 / globalScale;
            ctx.font = `${fontSize}px sans-serif`;
            ctx.fillStyle = globalScale > 1.5 ? textColorRef.current : mutedColorRef.current;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(label, node.x, node.y + nodeSize + 1.5 / globalScale);
          }
        }
      })
      // Track zoom level for UI display
      .onZoom((transform) => {
        setZoomLevel(Math.round(transform.k * 100));
      })
      // Click node → open the note (block nodes open their parent note)
      .onNodeClick((node: any) => {
        let notePath = node.id as string;
        const hashIdx = notePath.indexOf('#^');
        if (hashIdx !== -1) {
          notePath = notePath.substring(0, hashIdx);
        }
        const title = node.title || notePath;
        useNoteStore.getState().openNote(notePath, title);
        setGraphViewOpen(false);
      });

    graphRef.current = graph;
    justCreatedRef.current = true;

    // 力导向参数优化：增强节点间斥力，减少重叠
    graph.d3Force('charge')?.strength?.(-300);
    graph.d3Force('link')?.distance?.(80);

    // 加速衰减：默认 0.0228，设 0.3 让布局在约 20 帧内收敛，消除明显的开场飞散动画
    graph.d3AlphaDecay(0.3);

    // 布局稳定后立即居中，duration=0 无动画
    graph.onEngineStop(() => {
      graph.zoomToFit(0, 60);
    });

    // 响应窗口尺寸变化
    const handleResize = () => {
      graph.width(el.clientWidth).height(el.clientHeight);
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      try {
        // 停止 force-graph 内部的 RAF 循环和 D3 力仿真，避免内存/CPU 泄漏
        if (graphRef.current?._destructor) {
          graphRef.current._destructor();
        }
      } finally {
        // 即使 _destructor 抛出异常也确保 DOM 清理
        el.innerHTML = '';
        graphRef.current = null;
      }
    };
    // 只在图谱数据首次加载或组件关闭回调变化时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData, setGraphViewOpen]);

  // ── 时间轴滑动时增量更新图谱数据（不销毁/重建实例）──────
  useEffect(() => {
    if (!graphRef.current) return;
    // Skip redundant re-injection right after graph creation
    if (justCreatedRef.current) {
      justCreatedRef.current = false;
      return;
    }
    graphRef.current.graphData({
      nodes: filteredData.nodes.map((n) => ({ ...n })),
      links: filteredData.links.map((l) => ({ ...l })),
    });
  }, [filteredData]);

  // ── 键盘事件：Esc 关闭 ───────────────────────────────────
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setGraphViewOpen(false);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [setGraphViewOpen]);

  // 备用 React 键盘事件
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setGraphViewOpen(false);
      }
    },
    [setGraphViewOpen]
  );

  // ── 缩放控制 ─────────────────────────────────────────────
  const handleZoomIn = useCallback(() => {
    if (!graphRef.current) return;
    const current = graphRef.current.zoom() as number;
    graphRef.current.zoom(current * 1.3, 300);
  }, []);

  const handleZoomOut = useCallback(() => {
    if (!graphRef.current) return;
    const current = graphRef.current.zoom() as number;
    graphRef.current.zoom(current / 1.3, 300);
  }, []);

  const handleZoomFit = useCallback(() => {
    graphRef.current?.zoomToFit(400, 60);
  }, []);

  const handleRefresh = useCallback(() => {
    // Force reload graph data by resetting state
    setGraphData(null);
    setLoading(true);
    const loadPromise = localMode && currentNotePath
      ? getLocalGraph(currentNotePath, localDepth)
      : getGraphData(includeBlocks);
    loadPromise
      .then(setGraphData)
      .catch((err) => {
        console.warn('[graph] Failed to reload:', err);
        setGraphData({ nodes: [], links: [] });
      })
      .finally(() => setLoading(false));
  }, [localMode, currentNotePath, localDepth, includeBlocks]);

  // ── 格式化时间戳显示 ─────────────────────────────────────
  const cutoffLabel = useMemo(() => {
    if (!timelineEnabled || cutoffTs === Infinity || timeRange.max === 0) return '';
    return new Date(cutoffTs).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }, [timelineEnabled, cutoffTs, timeRange]);

  const startLabel = useMemo(() => {
    if (timeRange.min === 0) return '';
    return new Date(timeRange.min).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  }, [timeRange]);

  const endLabel = useMemo(() => {
    if (timeRange.max === 0) return '';
    return new Date(timeRange.max).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  }, [timeRange]);

  return (
    <div
      className="fixed inset-0 z-50 bg-background flex flex-col"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      ref={overlayRef}
    >
      {/* ── 标题栏（z-index 高于 canvas 防止被图谱遮挡） ───── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-theme-border shrink-0 relative z-10">
        {/* Left: stats */}
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-foreground">
            {t('graph.title')}
          </span>
          {graphData && graphData.nodes.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {filteredData.nodes.length} {t('graph.nodes')} · {filteredData.links.length} {t('graph.links')}
              {timelineEnabled && cutoffLabel && (
                <span className="ml-1.5">
                  — {cutoffLabel}
                </span>
              )}
            </span>
          )}
        </div>

        {/* Right: controls */}
        <div className="flex items-center gap-1">
          {/* Zoom controls */}
          <button
            onClick={handleZoomOut}
            className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
            title={t('graph.zoomOut')}
          >
            <ZoomOut size={15} />
          </button>
          <span className="text-[11px] text-muted-foreground min-w-[36px] text-center tabular-nums">
            {zoomLevel}%
          </span>
          <button
            onClick={handleZoomIn}
            className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
            title={t('graph.zoomIn')}
          >
            <ZoomIn size={15} />
          </button>
          <button
            onClick={handleZoomFit}
            className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
            title={t('graph.zoomFit')}
          >
            <Maximize2 size={15} />
          </button>
          <button
            onClick={handleRefresh}
            className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
            title={t('graph.refresh')}
          >
            <RotateCw size={15} />
          </button>

          {/* Separator */}
          <div className="w-px h-4 bg-theme-border mx-1" />

          {/* Local / Global toggle */}
          <button
            onClick={() => setLocalMode((v) => !v)}
            className={`p-1.5 rounded transition-colors ${
              localMode
                ? 'bg-theme-accent/20 text-theme-accent'
                : 'hover:bg-theme-hover text-muted-foreground'
            }`}
            title={localMode ? t('graph.globalGraph') : t('graph.localGraph')}
          >
            {localMode ? <Focus size={15} /> : <Globe size={15} />}
          </button>
          {/* Depth selector (only in local mode) */}
          {localMode && (
            <select
              value={localDepth}
              onChange={(e) => setLocalDepth(Number(e.target.value))}
              className="text-xs bg-background border border-theme-border rounded px-1.5 py-1 text-foreground"
              title={t('graph.depth')}
            >
              {[1, 2, 3, 4, 5].map((d) => (
                <option key={d} value={d}>{t('graph.depth')}: {d}</option>
              ))}
            </select>
          )}
          {/* Block nodes toggle */}
          <button
            onClick={() => setIncludeBlocks((v) => !v)}
            className={`p-1.5 rounded transition-colors ${
              includeBlocks
                ? 'bg-theme-accent/20 text-theme-accent'
                : 'hover:bg-theme-hover text-muted-foreground'
            }`}
            title={t('graph.blocksToggle')}
          >
            <Boxes size={15} />
          </button>
          {/* Timeline toggle */}
          <button
            onClick={() => setTimelineEnabled((v) => !v)}
            className={`p-1.5 rounded transition-colors ${
              timelineEnabled
                ? 'bg-theme-accent/20 text-theme-accent'
                : 'hover:bg-theme-hover text-muted-foreground'
            }`}
            title={t('graph.timelineToggle')}
          >
            <Clock size={15} />
          </button>
          <button
            onClick={() => setGraphViewOpen(false)}
            className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
            title={t('graph.close')}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* ── 图谱画布 ────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            {t('graph.loading')}
          </div>
        ) : graphData && graphData.nodes.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            {t('graph.noData')}
          </div>
        ) : (
          <div ref={containerRef} className="w-full h-full" />
        )}
      </div>

      {/* ── 时间轴滑块 ──────────────────────────────────────── */}
      {timelineEnabled && timeRange.max > 0 && (
        <div className="shrink-0 px-6 py-3 border-t border-theme-border bg-background/80 backdrop-blur-sm relative z-10">
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-muted-foreground whitespace-nowrap min-w-[60px]">
              {startLabel}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={sliderValue}
              onChange={(e) => setSliderValue(Number(e.target.value))}
              className="flex-1 h-1.5 accent-theme-accent cursor-pointer"
              aria-label={t('graph.timelineSlider')}
            />
            <span className="text-[10px] text-muted-foreground whitespace-nowrap min-w-[60px] text-right">
              {endLabel}
            </span>
          </div>

          {/* 氧化度图例 */}
          <div className="flex items-center justify-center gap-2 mt-1.5">
            <span className="text-[10px] text-muted-foreground">{t('graph.timelineOld')}</span>
            <div
              className="w-24 h-1.5 rounded-full"
              style={{
                background: `linear-gradient(to right, ${OXIDIZED_COLOR}, ${
                  getComputedStyle(document.documentElement).getPropertyValue('--theme-accent').trim() || '#ea580c'
                })`,
              }}
            />
            <span className="text-[10px] text-muted-foreground">{t('graph.timelineNew')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
