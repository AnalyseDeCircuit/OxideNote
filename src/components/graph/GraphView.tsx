/**
 * GraphView — 知识图谱可视化面板
 *
 * 使用 force-graph 库渲染笔记之间的 WikiLink 关系网络。
 * 采用力导向布局算法，节点代表笔记，连边代表引用关系。
 *
 * 交互特性：
 *   · 点击节点 → 打开对应笔记
 *   · 鼠标悬停 → 高亮关联节点与连边
 *   · 缩放/平移 → 自由探索大型图谱
 *   · 全屏覆盖层 → 按 Esc 或点击关闭按钮退出
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import ForceGraph from 'force-graph';

// force-graph 的默认导出类型为类构造器，
// 但运行时实际是工厂函数调用方式
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ForceGraphInstance = any;
import { getGraphData, type GraphData } from '@/lib/api';
import { useNoteStore } from '@/store/noteStore';
import { useUIStore } from '@/store/uiStore';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════
// GraphView 组件
// ═══════════════════════════════════════════════════════════════

export function GraphView() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphInstance>(null);
  const setGraphViewOpen = useUIStore((s) => s.setGraphViewOpen);

  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);

  // ── 加载图谱数据 ─────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    getGraphData()
      .then(setGraphData)
      .catch((err) => {
        console.warn('[graph] Failed to load graph data:', err);
        setGraphData({ nodes: [], links: [] });
      })
      .finally(() => setLoading(false));
  }, []);

  // ── 初始化 force-graph 实例 ──────────────────────────────
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const graph = (ForceGraph as any)()(el)
      .width(width)
      .height(height)
      .graphData({
        nodes: graphData.nodes.map((n) => ({ ...n })),
        links: graphData.links.map((l) => ({ ...l })),
      })
      .nodeLabel((node: any) => node.title || node.id)
      .nodeColor(() => accentColor)
      .nodeRelSize(5)
      .linkColor(() => borderColor)
      .linkWidth(1)
      .linkDirectionalArrowLength(4)
      .linkDirectionalArrowRelPos(1)
      .backgroundColor('transparent')
      // 节点文字标签
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const label = node.title || node.id;
        const fontSize = 11 / globalScale;
        ctx.font = `${fontSize}px sans-serif`;

        // 绘制节点圆点
        ctx.beginPath();
        ctx.arc(node.x, node.y, 4 / globalScale, 0, 2 * Math.PI);
        ctx.fillStyle = accentColor;
        ctx.fill();

        // 绘制标签
        ctx.fillStyle = globalScale > 1.5 ? textColor : mutedColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(label, node.x, node.y + 6 / globalScale);
      })
      // 点击节点 → 打开笔记
      .onNodeClick((node: any) => {
        const title = node.title || node.id;
        useNoteStore.getState().openNote(node.id, title);
        setGraphViewOpen(false);
      });

    graphRef.current = graph;

    // 居中适配
    setTimeout(() => {
      graph.zoomToFit(400, 60);
    }, 500);

    // 响应窗口尺寸变化
    const handleResize = () => {
      graph.width(el.clientWidth).height(el.clientHeight);
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      // force-graph 没有 destroy 方法，清空容器即可
      el.innerHTML = '';
      graphRef.current = null;
    };
  }, [graphData, setGraphViewOpen]);

  // ── 键盘事件：Esc 关闭 ───────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setGraphViewOpen(false);
      }
    },
    [setGraphViewOpen]
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-background/95 flex flex-col"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus
    >
      {/* ── 标题栏 ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-theme-border shrink-0">
        <span className="text-sm font-medium text-foreground">
          {t('graph.title')}
        </span>
        <button
          onClick={() => setGraphViewOpen(false)}
          className="p-1.5 rounded hover:bg-theme-hover transition-colors text-muted-foreground"
          title={t('graph.close')}
        >
          <X size={16} />
        </button>
      </div>

      {/* ── 图谱画布 ────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            Loading...
          </div>
        ) : graphData && graphData.nodes.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            {t('graph.noData')}
          </div>
        ) : (
          <div ref={containerRef} className="w-full h-full" />
        )}
      </div>
    </div>
  );
}
