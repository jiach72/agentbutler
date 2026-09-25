import { useEffect, useRef, useState } from "react";

export interface ChartPoint {
  x: number;
  y: number;
}

/**
 * Measures the physical pixel dimensions of a container element in real-time.
 * Eliminates SVG distortion caused by non-uniform `preserveAspectRatio="none"` scaling.
 * Supports SSR and static markup testing environments via default dimensions.
 */
export function useContainerDimensions(defaultWidth = 800, defaultHeight = 150) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({
    width: defaultWidth,
    height: defaultHeight,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let rafId: number | null = null;

    const measure = (w: number, h: number) => {
      if (w > 0) {
        const roundedW = Math.round(w);
        const roundedH = h > 0 ? Math.round(h) : defaultHeight;
        setDimensions((prev) => {
          if (prev.width === roundedW && prev.height === roundedH) return prev;
          return { width: roundedW, height: roundedH };
        });
      }
    };

    // Initial bounding measurement
    const initialRect = el.getBoundingClientRect();
    if (initialRect.width > 0) {
      measure(initialRect.width, initialRect.height || defaultHeight);
    }

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        if (!entries || entries.length === 0) return;
        const entry = entries[0];
        const { width, height } = entry.contentRect;
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          measure(width, height || initialRect.height || defaultHeight);
        });
      });
      observer.observe(el);
      return () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        observer.disconnect();
      };
    } else {
      const onResize = () => {
        const rect = el.getBoundingClientRect();
        measure(rect.width, rect.height || defaultHeight);
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
  }, [defaultHeight]);

  return { containerRef, width: dimensions.width, height: dimensions.height };
}

/**
 * Computes a smooth, monotonic cubic bezier SVG path from a list of points.
 * Implements the Fritsch-Carlson algorithm.
 * Guarantees that the curve NEVER overshoots local extrema and NEVER dips below
 * minimum values or baseline thresholds.
 */
export function getMonotoneCubicSplinePath(points: ChartPoint[]): string {
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  if (n === 2) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} L ${points[1].x.toFixed(1)} ${points[1].y.toFixed(1)}`;
  }

  // 1. Calculate secants (slopes between adjacent points)
  const dxs: number[] = [];
  const dys: number[] = [];
  const deltas: number[] = [];

  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    dxs.push(dx);
    dys.push(dy);
    deltas.push(dx === 0 ? 0 : dy / dx);
  }

  // 2. Calculate tangents
  const ms: number[] = new Array(n).fill(0);
  ms[0] = deltas[0];
  ms[n - 1] = deltas[n - 2];

  for (let i = 1; i < n - 1; i++) {
    const d0 = deltas[i - 1];
    const d1 = deltas[i];
    // If slope changes sign, tangent must be 0 to eliminate overshoot
    if (d0 * d1 <= 0) {
      ms[i] = 0;
    } else {
      // Harmonic mean gives smoother results and preserves monotonicity
      ms[i] = (2 * d0 * d1) / (d0 + d1);
    }
  }

  // 3. Fritsch-Carlson monotonicity check & clamp
  for (let i = 0; i < n - 1; i++) {
    const delta = deltas[i];
    if (delta === 0) {
      ms[i] = 0;
      ms[i + 1] = 0;
    } else {
      const alpha = ms[i] / delta;
      const beta = ms[i + 1] / delta;
      const dist = alpha * alpha + beta * beta;
      if (dist > 9) {
        const tau = 3 / Math.sqrt(dist);
        ms[i] = tau * alpha * delta;
        ms[i + 1] = tau * beta * delta;
      }
    }
  }

  // 4. Build SVG Cubic Bezier command path
  let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const dx = dxs[i] / 3;

    const cp1x = p0.x + dx;
    const cp1y = p0.y + ms[i] * dx;
    const cp2x = p1.x - dx;
    const cp2y = p1.y - ms[i + 1] * dx;

    path += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }

  return path;
}
