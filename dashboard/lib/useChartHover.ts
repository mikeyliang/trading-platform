"use client";

import { useState, useCallback, type MouseEvent } from "react";

/**
 * Maps pointer position over an SVG with `preserveAspectRatio="none"` and an
 * inner data band (excludes left/right gutter for axis labels) to a discrete
 * data index. Returned handlers plug directly into the SVG element.
 *
 * - `count` — number of points in the series (e.g. `prices.length`).
 * - `svgWidth` / `padLeft` / `padRight` — SVG-coord geometry, same constants the
 *   chart uses to lay out its data band.
 *
 * Indices outside the data band collapse to null so consumers can hide the
 * crosshair when the cursor is over the axis margin.
 */
export function useChartHover({
  count,
  svgWidth,
  padLeft,
  padRight,
}: {
  count: number;
  svgWidth: number;
  padLeft: number;
  padRight: number;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const onMouseMove = useCallback(
    (e: MouseEvent<SVGSVGElement>) => {
      if (count <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width === 0) return;
      const px = e.clientX - rect.left;
      const padLpx = (padLeft / svgWidth) * rect.width;
      const dataWpx = ((svgWidth - padLeft - padRight) / svgWidth) * rect.width;
      const rel = (px - padLpx) / dataWpx;
      if (rel < 0 || rel > 1) {
        setActiveIndex(null);
        return;
      }
      const idx = Math.round(rel * (count - 1));
      setActiveIndex(Math.max(0, Math.min(count - 1, idx)));
    },
    [count, svgWidth, padLeft, padRight]
  );

  const onMouseLeave = useCallback(() => setActiveIndex(null), []);

  return { activeIndex, onMouseMove, onMouseLeave };
}
