"use client";

import { useMemo } from "react";

interface SparklineProps {
  data: { time?: number; value: number }[] | number[];
  width?: number;
  height?: number;
  className?: string;
  stroke?: string;
  fill?: string;
  // when true, uses up/down green/red based on direction
  auto?: boolean;
  showLast?: boolean;
}

/**
 * Inline SVG sparkline. Pure presentational, no event handlers, no resize
 * observers. Designed for table cells, list rows, and small cards.
 */
export function Sparkline({
  data,
  width = 80,
  height = 24,
  className,
  stroke,
  fill,
  auto = true,
  showLast = false,
}: SparklineProps) {
  const values = useMemo(
    () => (Array.isArray(data) && data.length > 0 && typeof data[0] === "number"
      ? (data as number[])
      : (data as { value: number }[]).map((d) => d.value)),
    [data]
  );

  if (values.length < 2) {
    return (
      <div
        className={className}
        style={{ width, height }}
        aria-hidden
      />
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);

  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * height;
    return [x, y] as const;
  });

  const positive = values[values.length - 1] >= values[0];
  // Theme tokens, so the line reads on both surfaces.
  const lineColor = stroke ?? (auto ? (positive ? "var(--color-up)" : "var(--color-down)") : "var(--color-text-muted)");
  const fillColor = fill ?? (auto ? (positive ? "color-mix(in srgb, var(--color-up) 12%, transparent)" : "color-mix(in srgb, var(--color-down) 12%, transparent)") : "color-mix(in srgb, var(--color-text-muted) 10%, transparent)");

  const path = points.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(" ");
  const area = `${path} L${width},${height} L0,${height} Z`;

  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg
      width={width}
      height={height}
      className={className}
      role="img"
      aria-hidden
      style={{ display: "block" }}
    >
      <path d={area} fill={fillColor} />
      <path d={path} stroke={lineColor} strokeWidth={1.25} fill="none" />
      {showLast && (
        <circle cx={lastX} cy={lastY} r={1.75} fill={lineColor} />
      )}
    </svg>
  );
}
