"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import PropTypes from "prop-types";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AI_PROVIDERS } from "@/shared/constants/providers";

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

// Use local provider images from /public/providers/
function getProviderImageUrl(providerId) {
  return `/providers/${providerId}.png`;
}

// Custom provider node - rectangle with image + name
function ProviderNode({ data }) {
  const { label, color, imageUrl, textIcon, active } = data;
  const [imgError, setImgError] = useState(false);
  return (
    <div
      className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg border-2 transition-all duration-300 bg-bg"
      style={{
        borderColor: active ? color : "var(--color-border)",
        boxShadow: active ? `0 0 16px ${color}40` : "none",
        minWidth: "150px",
      }}
    >
      <Handle type="target" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      {/* Provider icon */}
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}15` }}
      >
        {!imgError ? (
          <img src={imageUrl} alt={label} className="w-6 h-6 rounded-sm object-contain" onError={() => setImgError(true)} />
        ) : (
          <span className="text-sm font-bold" style={{ color }}>{textIcon}</span>
        )}
      </div>

      {/* Provider name */}
      <span
        className="text-base font-medium truncate"
        style={{ color: active ? color : "var(--color-text)" }}
      >
        {label}
      </span>

      {/* Active indicator */}
      {active && (
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: color }} />
          <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: color }} />
        </span>
      )}
    </div>
  );
}

ProviderNode.propTypes = {
  data: PropTypes.object.isRequired,
};

// Center 9Router node
function RouterNode({ data }) {
  return (
    <div className="flex items-center justify-center px-5 py-3 rounded-xl border-2 border-primary bg-primary/5 shadow-md min-w-[130px]">
      <Handle type="source" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      <img src="/favicon.svg" alt="9Router" className="w-6 h-6 mr-2" />
      <span className="text-sm font-bold text-primary">9Router</span>
      {data.activeCount > 0 && (
        <span className="ml-2 px-1.5 py-0.5 rounded-full bg-primary text-white text-xs font-bold">
          {data.activeCount}
        </span>
      )}
    </div>
  );
}

RouterNode.propTypes = {
  data: PropTypes.object.isRequired,
};

const nodeTypes = { provider: ProviderNode, router: RouterNode };

// Rolling 60-second aggregation over recentRequests. Defined at module scope
// so React Compiler can memoize it; reading Date.now() inside useMemo would
// be flagged as impure (react-hooks/purity).
function computeLiveStats(recent, active) {
  const now = Date.now();
  const windowMs = 60_000;
  let tokensIn = 0;
  let tokensOut = 0;
  let count = 0;
  let errors = 0;
  for (const r of recent || []) {
    const t = r.timestamp ? new Date(r.timestamp).getTime() : NaN;
    if (!Number.isFinite(t) || now - t > windowMs) continue;
    tokensIn += r.promptTokens || 0;
    tokensOut += r.completionTokens || 0;
    count += 1;
    const s = (r.status || "ok").toString().toLowerCase();
    if (s !== "ok" && s !== "success" && s !== "200") errors += 1;
  }
  const activeCount = (active || []).length;
  return {
    tokensInPerSec: Math.round(tokensIn / 60),
    tokensOutPerSec: Math.round(tokensOut / 60),
    rpm: count,
    errorsPerMin: errors,
    activeCount,
    // streamCount is a proxy until a dedicated SSE counter is exposed
    streamCount: activeCount,
  };
}

// Place N nodes evenly along an ellipse around the router center.
// viewport = { width, height, isFullscreen } is optional — when provided and
// isFullscreen is true, rx/ry scale with the container so the distance
// between nodes grows, without ever changing node dimensions themselves.
function buildLayout(providers, activeSet, lastSet, errorSet, viewport) {
  const nodeW = 180;
  const nodeH = 30;
  const routerW = 120;
  const routerH = 44;
  const nodeGap = 24;

  const count = providers.length;

  // Compute rx so arc spacing between nodes >= nodeW + nodeGap
  const minRx = ((nodeW + nodeGap) * count) / (2 * Math.PI);

  let rx;
  let ry;
  if (viewport && viewport.isFullscreen && viewport.width > 0 && viewport.height > 0) {
    // In fullscreen: let radii expand with the available container so nodes
    // spread out. Leave generous margin (nodeW/2 + padding) so nodes don't
    // clip at the edges.
    const marginX = nodeW / 2 + 48;
    const marginY = nodeH / 2 + 48;
    const maxRx = Math.max(minRx, viewport.width / 2 - marginX);
    const maxRy = Math.max(minRx * 0.55, viewport.height / 2 - marginY);
    rx = Math.max(minRx, maxRx);
    ry = Math.max(minRx * 0.55, maxRy);
  } else {
    rx = Math.max(320, minRx);
    ry = Math.max(200, rx * 0.55); // ellipse ratio ~0.55
  }
  if (count === 0) {
    return {
      nodes: [{ id: "router", type: "router", position: { x: 0, y: 0 }, data: { activeCount: 0 }, draggable: false }],
      edges: [],
    };
  }

  const nodes = [];
  const edges = [];

  nodes.push({
    id: "router",
    type: "router",
    position: { x: -routerW / 2, y: -routerH / 2 },
    data: { activeCount: activeSet.size },
    draggable: false,
  });

  const edgeStyle = (active, last, error, color) => {
    if (error) return { stroke: "#ef4444", strokeWidth: 2.5, opacity: 0.9 };
    if (active) return { stroke: "#22c55e", strokeWidth: 2.5, opacity: 0.9 };
    if (last) return { stroke: "#f59e0b", strokeWidth: 2, opacity: 0.7 };
    return { stroke: "var(--color-border)", strokeWidth: 1, opacity: 0.3 };
  };

  providers.forEach((p, i) => {
    const config = getProviderConfig(p.provider);
    const active = activeSet.has(p.provider?.toLowerCase());
    const last = !active && lastSet.has(p.provider?.toLowerCase());
    const error = !active && errorSet.has(p.provider?.toLowerCase());
    const nodeId = `provider-${p.provider}`;
    const data = {
      label: (config.name !== p.provider ? config.name : null) || p.name || p.provider,
      color: config.color || "#6b7280",
      imageUrl: getProviderImageUrl(p.provider),
      textIcon: config.textIcon || (p.provider || "?").slice(0, 2).toUpperCase(),
      active,
    };

    // Distribute evenly starting from top (−π/2), clockwise
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    const cx = rx * Math.cos(angle);
    const cy = ry * Math.sin(angle);

    // Pick router handle closest to the node direction
    let sourceHandle, targetHandle;
    if (Math.abs(angle + Math.PI / 2) < Math.PI / 4 || Math.abs(angle - 3 * Math.PI / 2) < Math.PI / 4) {
      sourceHandle = "top"; targetHandle = "bottom";
    } else if (Math.abs(angle - Math.PI / 2) < Math.PI / 4) {
      sourceHandle = "bottom"; targetHandle = "top";
    } else if (cx > 0) {
      sourceHandle = "right"; targetHandle = "left";
    } else {
      sourceHandle = "left"; targetHandle = "right";
    }

    nodes.push({
      id: nodeId,
      type: "provider",
      position: { x: cx - nodeW / 2, y: cy - nodeH / 2 },
      data,
      draggable: false,
    });

    edges.push({
      id: `e-${nodeId}`,
      source: "router",
      sourceHandle,
      target: nodeId,
      targetHandle,
      animated: active,
      style: edgeStyle(active, last, error, config.color),
    });
  });

  return { nodes, edges };
}

export default function ProviderTopology({
  providers = [],
  activeRequests = [],
  lastProvider = "",
  errorProvider = "",
  recentRequests = [],
}) {
  // Serialize to stable string keys so useMemo only re-runs when values actually change
  const activeKey = useMemo(
    () => activeRequests.map((r) => r.provider?.toLowerCase()).filter(Boolean).sort().join(","),
    [activeRequests]
  );
  const lastKey = lastProvider?.toLowerCase() || "";
  const errorKey = errorProvider?.toLowerCase() || "";

  const activeSet = useMemo(() => new Set(activeKey ? activeKey.split(",") : []), [activeKey]);
  const lastSet = useMemo(() => new Set(lastKey ? [lastKey] : []), [lastKey]);
  const errorSet = useMemo(() => new Set(errorKey ? [errorKey] : []), [errorKey]);

  // --- Fullscreen state & container size tracking ---------------------------
  // Uses the browser Fullscreen API so the diagram takes over the whole
  // monitor (not just the viewport). Esc to exit is handled by the browser.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // Observe the React Flow canvas wrapper so buildLayout scales radii based
  // on the actual drawing area (excluding stats strip + log panel in fullscreen).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setContainerSize((prev) =>
          prev.width === width && prev.height === height ? prev : { width, height }
        );
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- Derived real-time stats (rolling 60s window from recentRequests) -----
  // Computed inline (not memoized) because it depends on Date.now(); React
  // Compiler auto-memoizes pure expressions and the loop is tiny (<=20 items).
  const liveStats = computeLiveStats(recentRequests, activeRequests);

  // Keep state in sync with the browser's real fullscreen status — catches
  // the user exiting via Esc, F11, or the system fullscreen UI.
  useEffect(() => {
    const onChange = () => {
      const fsEl =
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.msFullscreenElement ||
        null;
      setIsFullscreen(!!fsEl && fsEl === containerRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    document.addEventListener("msfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
      document.removeEventListener("msfullscreenchange", onChange);
    };
  }, []);

  const viewport = useMemo(
    () => ({ width: containerSize.width, height: containerSize.height, isFullscreen }),
    [containerSize.width, containerSize.height, isFullscreen]
  );

  const { nodes, edges } = useMemo(
    () => buildLayout(providers, activeSet, lastSet, errorSet, viewport),
    [providers, activeSet, lastSet, errorSet, viewport]
  );

  // Stable key — remount only when provider list or fullscreen mode changes
  // (remounting on fullscreen toggle ensures the initial viewport centers correctly)
  const providersKey = useMemo(
    () => providers.map((p) => p.provider).sort().join(",") + "|" + (isFullscreen ? "fs" : "n"),
    [providers, isFullscreen]
  );

  const rfInstance = useRef(null);
  const onInit = useCallback(
    (instance) => {
      rfInstance.current = instance;
      // Always fit view to the router node region; minZoom=maxZoom=1 guarantees
      // the nodes keep their original size (no scaling).
      setTimeout(() => instance.fitView({ padding: 0.2, minZoom: 1, maxZoom: 1 }), 50);
    },
    []
  );

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const fsEl =
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement ||
      null;
    if (fsEl) {
      const exit =
        document.exitFullscreen ||
        document.webkitExitFullscreen ||
        document.msExitFullscreen;
      if (exit) exit.call(document);
    } else {
      const req =
        el.requestFullscreen ||
        el.webkitRequestFullscreen ||
        el.msRequestFullscreen;
      if (req) {
        const result = req.call(el);
        if (result && typeof result.catch === "function") {
          // Ignore rejection (e.g. permissions, nested iframe); state will stay false
          result.catch(() => {});
        }
      }
    }
  }, []);

  // In browser fullscreen, the element itself fills the monitor — we just
  // need a solid background so the sub-grid card styling doesn't leak.
  const frameClass = isFullscreen
    ? "w-full h-full rounded-none border-0 bg-bg"
    : "w-full rounded-lg border border-border bg-bg-subtle/30";
  const frameStyle = isFullscreen ? undefined : { height: 480 };

  return (
    <div ref={containerRef} className={`${frameClass} relative flex flex-col overflow-hidden`} style={frameStyle}>
      {/* Fullscreen toggle button (always visible) */}
      <button
        type="button"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        className="absolute top-2 right-2 z-10 w-8 h-8 flex items-center justify-center rounded-md border border-border bg-bg/80 backdrop-blur-sm text-text-muted hover:text-primary hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
      >
        <span className="material-symbols-outlined text-[18px] leading-none">
          {isFullscreen ? "fullscreen_exit" : "fullscreen"}
        </span>
      </button>

      {/* Stats strip — fullscreen only */}
      {isFullscreen && <LiveStatsStrip stats={liveStats} />}

      {/* Canvas — always renders, takes remaining space */}
      <div ref={canvasRef} className="flex-1 min-h-0 relative">
        {providers.length === 0 ? (
          <div className="h-full flex items-center justify-center text-text-muted text-sm">
            No providers connected
          </div>
        ) : (
          <ReactFlow
            key={providersKey}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2, minZoom: 1, maxZoom: 1 }}
            minZoom={1}
            maxZoom={1}
            onInit={onInit}
            proOptions={{ hideAttribution: true }}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
          />
        )}
      </div>

      {/* Live request log — fullscreen only */}
      {isFullscreen && <LiveRequestLog requests={recentRequests} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components: rendered only in fullscreen mode
// ---------------------------------------------------------------------------

function LiveStatsStrip({ stats }) {
  const chips = [
    { key: "in", label: "tokens in/s", value: stats.tokensInPerSec.toLocaleString(), color: "text-blue-500", arrow: "↓" },
    { key: "out", label: "tokens out/s", value: stats.tokensOutPerSec.toLocaleString(), color: "text-green-500", arrow: "↑" },
    { key: "rpm", label: "rpm", value: stats.rpm.toString() },
    { key: "active", label: "active", value: stats.activeCount.toString() },
    { key: "streams", label: "streams", value: stats.streamCount.toString() },
    {
      key: "err",
      label: "errors / 1m",
      value: stats.errorsPerMin.toString(),
      color: stats.errorsPerMin > 0 ? "text-red-500" : "text-text-muted",
    },
  ];

  return (
    <div className="shrink-0 mx-3 mt-3 mr-14 h-11 flex items-center gap-5 px-4 rounded-lg border border-border bg-bg/70 backdrop-blur-sm z-[5]">
      {chips.map((c, i) => (
        <div key={c.key} className="flex items-center">
          {i > 0 && <span className="mr-5 h-6 w-px bg-border" />}

          <div className="flex items-baseline gap-1.5">
            {c.arrow && <span className={`text-sm ${c.color}`}>{c.arrow}</span>}
            <span className="text-[11px] uppercase tracking-wide text-text-muted">
              {c.label}
            </span>
            <span className={`text-sm font-semibold tabular-nums ${c.color || "text-text"}`}>
              {c.value}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

LiveStatsStrip.propTypes = {
  stats: PropTypes.shape({
    tokensInPerSec: PropTypes.number,
    tokensOutPerSec: PropTypes.number,
    rpm: PropTypes.number,
    activeCount: PropTypes.number,
    streamCount: PropTypes.number,
    errorsPerMin: PropTypes.number,
  }).isRequired,
};

function formatLogTime(ts) {
  if (!ts) return "--:--:--";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function statusClass(status) {
  const s = (status || "ok").toString().toLowerCase();
  if (s === "ok" || s === "success" || s === "200") return "text-green-400";
  if (s.startsWith("4")) return "text-amber-400";
  return "text-red-400";
}

function LiveRequestLog({ requests }) {
  const router = useRouter();
  const rows = (requests || []).slice(0, 20);
  return (
    <div
      className="shrink-0 mx-3 mb-3 rounded-lg border overflow-hidden font-mono text-[12px] flex flex-col"
      style={{ background: "#1e1b18", color: "#d8cfc2", borderColor: "#2c2825", height: 220 }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: "#2c2825", background: "#141210" }}>
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: "#22c55e", animation: "topo-pulse 1.5s infinite" }}
        />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-white">Live Request Log</span>
        <span className="flex-1" />
        <span className="text-[11px] text-[#8a807a]">
          showing last {rows.length} · click row → Details tab
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-[#645e57]">No recent requests.</div>
        ) : (
          rows.map((r, i) => (
            <div
              key={`${r.timestamp}-${i}`}
              className="grid items-baseline gap-3 px-3 py-1 border-b hover:bg-[#2a2623] transition-colors cursor-pointer"
              style={{
                gridTemplateColumns: "80px 130px 14px 1fr 70px 80px",
                borderColor: "#26221f",
              }}
              onClick={() => router.push("/dashboard/usage?tab=details")}
            >
              <span className="text-[#8a807a]">{formatLogTime(r.timestamp)}</span>
              <span className="truncate text-[#8ec5ff]" title={r.provider}>{r.provider || "—"}</span>
              <span className="text-[#555]">→</span>
              <span className="truncate text-[#d8cfc2]" title={r.model}>{r.model || "—"}</span>
              <span className="text-right tabular-nums">
                <span className="text-[#7eb3ff]">{(r.promptTokens || 0).toLocaleString()}↑</span>
                <span className="text-[#8a807a]"> / </span>
                <span className="text-[#5fd68a]">{(r.completionTokens || 0).toLocaleString()}↓</span>
              </span>
              <span className={`text-right ${statusClass(r.status)}`}>{r.status || "ok"}</span>
            </div>
          ))
        )}
      </div>
      <style jsx>{`
        @keyframes topo-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

LiveRequestLog.propTypes = {
  requests: PropTypes.arrayOf(
    PropTypes.shape({
      timestamp: PropTypes.string,
      model: PropTypes.string,
      provider: PropTypes.string,
      promptTokens: PropTypes.number,
      completionTokens: PropTypes.number,
      status: PropTypes.string,
    })
  ),
};

ProviderTopology.propTypes = {
  providers: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    provider: PropTypes.string,
    name: PropTypes.string,
  })),
  activeRequests: PropTypes.arrayOf(PropTypes.shape({
    provider: PropTypes.string,
    model: PropTypes.string,
    account: PropTypes.string,
  })),
  lastProvider: PropTypes.string,
  errorProvider: PropTypes.string,
  recentRequests: PropTypes.arrayOf(PropTypes.shape({
    timestamp: PropTypes.string,
    model: PropTypes.string,
    provider: PropTypes.string,
    promptTokens: PropTypes.number,
    completionTokens: PropTypes.number,
    status: PropTypes.string,
  })),
};
