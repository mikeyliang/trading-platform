"use client";

import { useMemo } from "react";
import { useChartHover } from "@/lib/useChartHover";

interface Props {
  /** modelled option price over recent underlying bars */
  prices: number[];
  ema9: number[];
  ema21: number[];
  title?: string;
  height?: number;
}

/** Compact area chart of synthetic option price with EMA9 / EMA21 overlays. */
export function OptionEmaChart({
  prices,
  ema9,
  ema21,
  title,
  height = 200,
}: Props) {
  const W = 700;
  const H = height;
  const PAD_L = 50;
  const PAD_R = 8;
  const PAD_T = 12;
  const PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const { pricePath, ema9Path, ema21Path, areaPath, ticks, yOf, xOf, hi, lo } =
    useMemo(() => {
      if (prices.length === 0) {
        return {
          pricePath: "",
          ema9Path: "",
          ema21Path: "",
          areaPath: "",
          ticks: [],
          yOf: () => 0,
          xOf: () => 0,
          hi: 0,
          lo: 0,
        };
      }
      const all = [...prices, ...ema9, ...ema21];
      const minV = Math.min(...all);
      const maxV = Math.max(...all);
      const pad = Math.max(0.01, (maxV - minV) * 0.15);
      const yMin = Math.max(0, minV - pad);
      const yMax = maxV + pad;

      const yOf = (v: number) =>
        PAD_T + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;
      const xOf = (i: number) =>
        PAD_L + (i / Math.max(prices.length - 1, 1)) * innerW;

      const mkPath = (arr: number[]) =>
        arr
          .map(
            (v, i) =>
              `${i === 0 ? "M" : "L"}${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`,
          )
          .join(" ");

      const area =
        `M${xOf(0).toFixed(2)},${(PAD_T + innerH).toFixed(2)} ` +
        prices
          .map((v, i) => `L${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`)
          .join(" ") +
        ` L${xOf(prices.length - 1).toFixed(2)},${(PAD_T + innerH).toFixed(2)} Z`;

      const target = 4;
      const range = yMax - yMin;
      const rawStep = range / target;
      const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
      const step = Math.max(0.01, Math.ceil(rawStep / mag) * mag);
      const tk: number[] = [];
      const start = Math.ceil(yMin / step) * step;
      for (let v = start; v <= yMax; v += step) tk.push(v);

      return {
        pricePath: mkPath(prices),
        ema9Path: mkPath(ema9),
        ema21Path: mkPath(ema21),
        areaPath: area,
        ticks: tk,
        yOf,
        xOf,
        hi: maxV,
        lo: minV,
      };
    }, [prices, ema9, ema21, innerH, innerW]);

  const last = prices[prices.length - 1];
  const first = prices[0];
  const change = first ? ((last - first) / first) * 100 : 0;

  const { activeIndex, onMouseMove, onMouseLeave } = useChartHover({
    count: prices.length,
    svgWidth: W,
    padLeft: PAD_L,
    padRight: PAD_R,
  });
  const hover =
    activeIndex != null
      ? {
          i: activeIndex,
          price: prices[activeIndex],
          e9: ema9[activeIndex],
          e21: ema21[activeIndex],
          ago: prices.length - 1 - activeIndex,
        }
      : null;

  return (
    <div className="relative w-full">
      <div className="flex items-center gap-2 mb-1">
        {title && (
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            {title}
          </span>
        )}
        <span className="text-[10px] tabular text-text-secondary ml-auto">
          {hover ? (
            <>
              <span className="text-text-muted">
                {hover.ago === 0 ? "now" : `−${hover.ago}d`}
              </span>
              <span className="ml-2 text-sky-400">px</span>{" "}
              <span className="text-text-primary font-medium">
                ${hover.price?.toFixed(2)}
              </span>
              <span className="ml-2 text-green-500">E9</span>{" "}
              <span className="text-text-primary">${hover.e9?.toFixed(2)}</span>
              <span className="ml-2 text-amber-400">E21</span>{" "}
              <span className="text-text-primary">
                ${hover.e21?.toFixed(2)}
              </span>
            </>
          ) : (
            <>
              last{" "}
              <span className="text-text-primary font-medium">
                ${last?.toFixed(2)}
              </span>
              <span className={change >= 0 ? "text-up ml-2" : "text-down ml-2"}>
                {change >= 0 ? "+" : ""}
                {change.toFixed(1)}%
              </span>
            </>
          )}
        </span>
      </div>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block cursor-crosshair"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        <defs>
          <linearGradient id="optAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(56,189,248)" stopOpacity="0.35" />
            <stop
              offset="100%"
              stopColor="rgb(56,189,248)"
              stopOpacity="0.02"
            />
          </linearGradient>
        </defs>

        {ticks.map((t, i) => (
          <g key={`t-${i}`}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yOf(t)}
              y2={yOf(t)}
              stroke="rgb(148,163,184)"
              strokeOpacity={0.06}
              strokeDasharray="2 4"
            />
            <text
              x={PAD_L - 6}
              y={yOf(t) + 3}
              fontSize="9"
              fill="rgb(148,163,184)"
              textAnchor="end"
              className="tabular-nums"
            >
              ${t.toFixed(2)}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="url(#optAreaGrad)" />
        <path
          d={pricePath}
          stroke="rgb(56,189,248)"
          strokeWidth="1.6"
          fill="none"
        />
        <path
          d={ema9Path}
          stroke="rgb(34,197,94)"
          strokeWidth="1.2"
          fill="none"
          strokeOpacity={0.95}
        />
        <path
          d={ema21Path}
          stroke="rgb(251,191,36)"
          strokeWidth="1.2"
          fill="none"
          strokeOpacity={0.95}
        />

        {prices.length > 0 && (
          <circle
            cx={xOf(prices.length - 1)}
            cy={yOf(last)}
            r={3}
            fill="rgb(56,189,248)"
          />
        )}

        {hover && (
          <g pointerEvents="none">
            <line
              x1={xOf(hover.i)}
              x2={xOf(hover.i)}
              y1={PAD_T}
              y2={H - PAD_B}
              stroke="rgb(244,244,245)"
              strokeOpacity={0.35}
              strokeDasharray="3 3"
            />
            <circle
              cx={xOf(hover.i)}
              cy={yOf(hover.price)}
              r={3}
              fill="rgb(56,189,248)"
            />
            <circle
              cx={xOf(hover.i)}
              cy={yOf(hover.e9)}
              r={2.5}
              fill="rgb(34,197,94)"
            />
            <circle
              cx={xOf(hover.i)}
              cy={yOf(hover.e21)}
              r={2.5}
              fill="rgb(251,191,36)"
            />
          </g>
        )}
      </svg>
      <div className="flex items-center gap-3 text-[9px] text-text-secondary mt-0.5">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-0.5 bg-sky-400" /> price
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-0.5 bg-green-500" /> EMA9
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-0.5 bg-amber-400" /> EMA21
        </span>
      </div>
    </div>
  );
}
