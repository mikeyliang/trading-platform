"use client";

import { useMemo } from "react";
import { useChartHover } from "@/lib/useChartHover";
import { CHART } from "@/lib/chartTheme";

interface Point {
  days_remaining: number;
  pnl_flat: number; // PnL if spot is unchanged at this future date
  pnl_up_1s: number; // PnL if spot is +1σ by this date
  pnl_dn_1s: number; // PnL if spot is -1σ by this date
}

interface Props {
  data: Point[];
  height?: number;
}

/** Time-axis P&L curve: "If I hold this position, what does the calendar do to me?"
 *
 *  Replaces the old synthetic BS-replay chart with something a trader can
 *  actually act on. Three lines: flat-spot (pure theta decay or accrual),
 *  +1σ spot path (move in your favor), −1σ spot path (move against you).
 *  The flat line is the headline read on whether time is your friend or
 *  your enemy; the ±1σ envelope shows how much a typical move offsets it.
 *
 *  X-axis runs left=now → right=expiry (days_remaining shrinks to zero).
 */
export function PnlDecayChart({ data, height = 210 }: Props) {
  const W = 800;
  const H = height;
  const PAD_L = 56;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const { xOf, yOf, yZero, ticks, xMin, xMax } = useMemo(() => {
    const all = data.flatMap((p) => [p.pnl_flat, p.pnl_up_1s, p.pnl_dn_1s]);
    const minV = Math.min(...all, 0);
    const maxV = Math.max(...all, 0);
    const padY = Math.max(1, (maxV - minV) * 0.1);
    const yMn = minV - padY;
    const yMx = maxV + padY;

    // x is "elapsed days from now" — so leftmost = today, rightmost = expiry.
    // data[0].days_remaining is the largest (full DTE); data[N-1] = 0.
    const fullDte = data.length ? data[0].days_remaining : 0;
    const xMn = 0;
    const xMx = fullDte;

    const xOf = (elapsedDays: number) =>
      PAD_L + (xMx > 0 ? (elapsedDays / xMx) * innerW : 0);
    const yOf = (v: number) =>
      PAD_T + innerH - ((v - yMn) / (yMx - yMn)) * innerH;
    const yZero = yOf(0);

    // Nice y ticks
    const range = yMx - yMn;
    const target = 4;
    const rawStep = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = Math.ceil(rawStep / mag) * mag;
    const ticks: number[] = [];
    const start = Math.ceil(yMn / step) * step;
    for (let v = start; v <= yMx; v += step) ticks.push(v);

    return { xOf, yOf, yZero, ticks, xMin: xMn, xMax: xMx };
  }, [data, innerW, innerH]);

  const pathFor = (key: keyof Omit<Point, "days_remaining">) =>
    data
      .map((p, i) => {
        const elapsed = xMax - p.days_remaining;
        return `${i === 0 ? "M" : "L"}${xOf(elapsed).toFixed(1)},${yOf(p[key]).toFixed(1)}`;
      })
      .join(" ");

  const flatPath = useMemo(() => pathFor("pnl_flat"), [data, xOf, yOf, xMax]);
  const upPath = useMemo(() => pathFor("pnl_up_1s"), [data, xOf, yOf, xMax]);
  const dnPath = useMemo(() => pathFor("pnl_dn_1s"), [data, xOf, yOf, xMax]);

  // ±1σ envelope between up and down lines.
  const envelope = useMemo(() => {
    if (data.length === 0) return "";
    const up = data
      .map((p, i) => {
        const elapsed = xMax - p.days_remaining;
        return `${i === 0 ? "M" : "L"}${xOf(elapsed).toFixed(1)},${yOf(p.pnl_up_1s).toFixed(1)}`;
      })
      .join(" ");
    const dn = data
      .slice()
      .reverse()
      .map((p) => {
        const elapsed = xMax - p.days_remaining;
        return `L${xOf(elapsed).toFixed(1)},${yOf(p.pnl_dn_1s).toFixed(1)}`;
      })
      .join(" ");
    return `${up} ${dn} Z`;
  }, [data, xOf, yOf, xMax]);

  const { activeIndex, onMouseMove, onMouseLeave } = useChartHover({
    count: data.length,
    svgWidth: W,
    padLeft: PAD_L,
    padRight: PAD_R,
  });
  const hover = activeIndex != null ? data[activeIndex] : null;

  // x ticks: 5 evenly spaced day labels
  const xLabels = useMemo(() => {
    const n = 5;
    return Array.from({ length: n + 1 }, (_, i) => Math.round((xMax * i) / n));
  }, [xMax]);

  return (
    <div className="relative w-full">
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block cursor-crosshair"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        {/* Same gradient language as the underlying-chart's forecast cone —
            light at the anchor (today), heavier toward expiry. Signals
            growing uncertainty / outcome dispersion at the same time the
            forecast cone does on the other chart. */}
        <defs>
          <linearGradient id="pnl-decay-grad" x1="0" y1="0" x2="1" y2="0">
            <stop
              offset="0%"
              stopColor={CHART.forecast.cone}
              stopOpacity="0.05"
            />
            <stop
              offset="100%"
              stopColor={CHART.forecast.cone}
              stopOpacity="0.24"
            />
          </linearGradient>
        </defs>

        {/* y gridlines */}
        {ticks.map((t, i) => (
          <g key={`g-${i}`}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yOf(t)}
              y2={yOf(t)}
              stroke={CHART.axisText}
              strokeOpacity={t === 0 ? 0.4 : 0.07}
              strokeDasharray={t === 0 ? "none" : "2 4"}
            />
            <text
              x={PAD_L - 6}
              y={yOf(t) + 3}
              fontSize="10"
              fill={CHART.axisText}
              textAnchor="end"
              className="tabular-nums"
            >
              {fmtPnl(t)}
            </text>
          </g>
        ))}

        {/* x labels: days from now */}
        {xLabels.map((d, i) => (
          <text
            key={`xl-${i}`}
            x={xOf(d)}
            y={H - PAD_B + 14}
            fontSize="10"
            fill={CHART.axisText}
            textAnchor="middle"
            className="tabular-nums"
          >
            {d === 0 ? "now" : `+${d}d`}
          </text>
        ))}

        {/* ±1σ envelope — gradient fill, matches forecast cone visual */}
        <path d={envelope} fill="url(#pnl-decay-grad)" />

        {/* curves */}
        <path
          d={dnPath}
          stroke={CHART.down}
          strokeWidth="1.2"
          fill="none"
          opacity={0.85}
          strokeDasharray="3 3"
        />
        <path
          d={upPath}
          stroke={CHART.up}
          strokeWidth="1.2"
          fill="none"
          opacity={0.85}
          strokeDasharray="3 3"
        />
        <path d={flatPath} stroke={CHART.text} strokeWidth="1.8" fill="none" />

        {/* Today anchor — halo + dot, mirrors the cone's last-close anchor */}
        {data.length > 0 &&
          (() => {
            const x0 = xOf(0);
            const y0 = yOf(data[0].pnl_flat);
            return (
              <g pointerEvents="none">
                <circle
                  cx={x0}
                  cy={y0}
                  r={4.5}
                  fill={CHART.text}
                  fillOpacity={0.18}
                />
                <circle cx={x0} cy={y0} r={2.5} fill={CHART.text} />
              </g>
            );
          })()}

        {/* Terminal labels at expiry — match the forecast cone's right-edge
            labels. Vertically de-overlap if labels cluster. */}
        {data.length > 0 &&
          (() => {
            const last = data[data.length - 1];
            const xR = xOf(xMax) - 2;
            const labels = [
              {
                y: yOf(last.pnl_up_1s),
                color: CHART.up,
                text: `+1σ ${fmtPnl(last.pnl_up_1s)}`,
              },
              {
                y: yOf(last.pnl_flat),
                color: CHART.text,
                text: `flat ${fmtPnl(last.pnl_flat)}`,
              },
              {
                y: yOf(last.pnl_dn_1s),
                color: CHART.down,
                text: `−1σ ${fmtPnl(last.pnl_dn_1s)}`,
              },
            ].sort((a, b) => a.y - b.y);
            const minSpacing = 12;
            for (let i = 1; i < labels.length; i++) {
              if (labels[i].y - labels[i - 1].y < minSpacing) {
                labels[i].y = labels[i - 1].y + minSpacing;
              }
            }
            return labels.map((l, i) => (
              <text
                key={`tl-${i}`}
                x={xR}
                y={l.y + 3}
                fontSize="9"
                fill={l.color}
                textAnchor="end"
                fontWeight={500}
                className="tabular-nums"
              >
                {l.text}
              </text>
            ));
          })()}

        {/* Horizon hint top-right */}
        <text
          x={W - PAD_R - 2}
          y={PAD_T + 10}
          fontSize="9"
          fill={CHART.forecast.cone}
          textAnchor="end"
          fontWeight={600}
          className="tabular-nums"
        >
          +{xMax}d horizon
        </text>

        {/* hover line */}
        {hover && (
          <g pointerEvents="none">
            <line
              x1={xOf(xMax - hover.days_remaining)}
              x2={xOf(xMax - hover.days_remaining)}
              y1={PAD_T}
              y2={H - PAD_B}
              stroke={CHART.text}
              strokeOpacity={0.35}
              strokeDasharray="3 3"
            />
            <circle
              cx={xOf(xMax - hover.days_remaining)}
              cy={yOf(hover.pnl_flat)}
              r={3}
              fill={CHART.text}
            />
            <circle
              cx={xOf(xMax - hover.days_remaining)}
              cy={yOf(hover.pnl_up_1s)}
              r={2.5}
              fill={CHART.up}
            />
            <circle
              cx={xOf(xMax - hover.days_remaining)}
              cy={yOf(hover.pnl_dn_1s)}
              r={2.5}
              fill={CHART.down}
            />
          </g>
        )}
      </svg>

      <div className="absolute top-1 right-3 flex items-center gap-2 text-[10px] tabular bg-surface/85 backdrop-blur rounded-md px-2 py-1 border border-border/40">
        {hover ? (
          <>
            <span className="text-text-muted">
              {hover.days_remaining === 0
                ? "expiry"
                : `${xMax - hover.days_remaining}d from now`}
            </span>
            <span>
              <span className="text-text-muted">flat</span>{" "}
              <span className={pnlClass(hover.pnl_flat)}>
                {fmtPnl(hover.pnl_flat)}
              </span>
            </span>
            <span>
              <span className="text-up">+1σ</span>{" "}
              <span className={pnlClass(hover.pnl_up_1s)}>
                {fmtPnl(hover.pnl_up_1s)}
              </span>
            </span>
            <span>
              <span className="text-down">−1σ</span>{" "}
              <span className={pnlClass(hover.pnl_dn_1s)}>
                {fmtPnl(hover.pnl_dn_1s)}
              </span>
            </span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-0.5 bg-white" /> spot
              unchanged
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-0.5 bg-up" /> +1σ path
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-0.5 bg-down" /> −1σ path
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function pnlClass(v: number) {
  return v >= 0 ? "text-up font-medium" : "text-down font-medium";
}

function fmtPnl(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000)
    return `${v < 0 ? "-" : ""}$${(a / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `${v < 0 ? "-" : ""}$${(a / 1_000).toFixed(1)}k`;
  return `${v < 0 ? "-" : ""}$${a.toFixed(0)}`;
}
