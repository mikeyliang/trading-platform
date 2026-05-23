"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sparkles, Loader2, CheckCircle2, XCircle, History, Newspaper, TrendingUp,
  CircleDollarSign, Brain, Hourglass, ArrowRight, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { type OptionAnalyzeResult } from "@/lib/api";
import { cn, fmtCurrency } from "@/lib/utils";
import { CHART } from "@/lib/chartTheme";

interface Props {
  result: OptionAnalyzeResult;
}

type AgentName = "news" | "underlying" | "option" | "decay" | "synthesis";
type AgentStatus = "pending" | "running" | "complete" | "error";

interface AgentState {
  status: AgentStatus;
  output?: string;
  error?: string;
  model?: string;
  headlines?: Array<{ title: string; source: string; published: string; link: string }>;
  // Wall-clock when the agent started running. Used to compute live
  // elapsed time during "thinking" status.
  startedAt?: number;
  // Wall-clock when it finished — used for "ran in 4.2s" badge.
  finishedAt?: number;
}

interface RunHistoryRow {
  id: number;
  ran_at: string;
  duration_ms: number | null;
  agents: Record<string, { output?: string; model?: string; headlines?: any[]; error?: string }>;
}

// Parallel batch first (news/underlying/option/decay all run concurrently),
// then synthesis last (depends on the four above).
const PARALLEL_AGENTS: AgentName[] = ["news", "underlying", "option", "decay"];
const AGENT_ORDER: AgentName[] = [...PARALLEL_AGENTS, "synthesis"];

const AGENT_META: Record<AgentName, {
  label: string;
  shortLabel: string;
  desc: string;
  icon: typeof Newspaper;
  accent: string;
}> = {
  news: {
    label: "News Analyst",
    shortLabel: "News",
    desc: "Scans recent headlines for the narrative.",
    icon: Newspaper,
    accent: CHART.forecast.cone,
  },
  underlying: {
    label: "Underlying Analyst",
    shortLabel: "Underlying",
    desc: "Reads candles, indicators, and the forecast cone.",
    icon: TrendingUp,
    accent: CHART.up,
  },
  option: {
    label: "Option Analyst",
    shortLabel: "Option",
    desc: "IV vs realized, DTE phase, greeks, liquidity.",
    icon: CircleDollarSign,
    accent: CHART.ema.fast,
  },
  decay: {
    label: "Decay Analyst",
    shortLabel: "Decay",
    desc: "P/L over time, theta path, ±1σ envelope.",
    icon: Hourglass,
    accent: CHART.ref.strike,
  },
  synthesis: {
    label: "Position Coordinator",
    shortLabel: "Synthesis",
    desc: "Combines the four reads into a verdict.",
    icon: Brain,
    accent: CHART.warning,
  },
};

const EMPTY_STATE: Record<AgentName, AgentState> = {
  news: { status: "pending" },
  underlying: { status: "pending" },
  option: { status: "pending" },
  decay: { status: "pending" },
  synthesis: { status: "pending" },
};

// ── Context summaries — what data each agent sees ─────────────────────
function buildContextChips(name: AgentName, result: OptionAnalyzeResult): string[] {
  const u = result.underlying;
  const g = result.greeks;
  switch (name) {
    case "news":
      return [
        `${result.symbol} ticker`,
        "RSS feed (Yahoo + Google News)",
      ];
    case "underlying":
      return [
        `RSI ${u?.rsi?.toFixed(0) ?? "—"}`,
        `EMA 9/21/200 stack`,
        `5d forecast ${result.forecast_ensemble?.ensemble.horizons["5"]?.expected_return_pct?.toFixed(1) ?? "—"}%`,
        `${(result.forecast_ensemble?.agreement["5"] ?? 0) * 100 < 1 ? "—" : ((result.forecast_ensemble?.agreement["5"] ?? 0) * 100).toFixed(0) + "% agreement"}`,
      ].filter((c) => !c.includes("—"));
    case "option":
      return [
        `IV ${(result.option.iv * 100).toFixed(1)}%`,
        result.vol_context?.iv_to_rv_ratio
          ? `IV/RV ${result.vol_context.iv_to_rv_ratio.toFixed(2)}×`
          : "",
        `Δ ${g?.delta?.toFixed(3) ?? "—"}`,
        `${result.dte}d DTE`,
        `liquidity ${result.liquidity?.grade ?? "—"}`,
      ].filter((c) => c && !c.endsWith("—"));
    case "decay":
      return [
        result.decay_profile
          ? `${result.decay_profile.length} P/L-over-time points`
          : "decay_profile unavailable",
        `θ ${g?.theta?.toFixed(4) ?? "—"}/day`,
        `${result.dte}d to expiry`,
        result.max_loss != null
          ? `max loss ${fmtCurrency(result.max_loss)}`
          : "",
      ].filter((c) => c);
    case "synthesis":
      return [
        "feeds on news + underlying + option + decay",
        "outputs verdict + trigger + risk",
      ];
  }
}

/**
 * Multi-agent AI Read with full pipeline visualization. Streams five
 * agents' progress from the backend SSE endpoint, then persists the run
 * to postgres. Visualization layers:
 *   - Pipeline header: horizontal flow with status circles + arrows
 *   - Agent rows: icon, label, status badge, live elapsed timer,
 *     context chips, output panel
 *   - History list: past runs on this contract; click to reload
 */
export function AIRead({ result }: Props) {
  const [agents, setAgents] = useState<Record<AgentName, AgentState>>(EMPTY_STATE);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [history, setHistory] = useState<RunHistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Tick once per second while any agent is running so the elapsed
  // timer in each agent card actually moves.
  const [, setTick] = useState(0);
  const anyRunning = AGENT_ORDER.some((n) => agents[n].status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [anyRunning]);

  // ── load history when the contract changes ──────────────────────────
  const reloadHistory = useCallback(async () => {
    try {
      const q = new URLSearchParams({
        symbol: result.symbol,
        strike: String(result.strike),
        expiry: result.expiry,
        right: result.right,
        limit: "5",
      });
      const resp = await fetch(`/api/options/agent-runs?${q}`);
      if (!resp.ok) return;
      const rows = (await resp.json()) as RunHistoryRow[];
      setHistory(rows);
    } catch {
      // History is nice-to-have — don't surface a failure.
    }
  }, [result.symbol, result.strike, result.expiry, result.right]);

  useEffect(() => { reloadHistory(); }, [reloadHistory]);

  // ── load a previous run into the agent boxes ────────────────────────
  const loadRun = (row: RunHistoryRow) => {
    const next: Record<AgentName, AgentState> = {
      news: { status: "pending" },
      underlying: { status: "pending" },
      option: { status: "pending" },
      decay: { status: "pending" },
      synthesis: { status: "pending" },
    };
    for (const name of AGENT_ORDER) {
      const a = row.agents[name];
      if (a) {
        next[name] = {
          status: a.error ? "error" : "complete",
          output: a.output,
          error: a.error,
          model: a.model,
          headlines: a.headlines,
        };
      }
    }
    setAgents(next);
    setRunId(row.id);
    setDurationMs(row.duration_ms);
    setError(null);
  };

  // ── run the streaming pipeline ──────────────────────────────────────
  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    setRunId(null);
    setDurationMs(null);
    setAgents({
      news: { status: "pending" },
      underlying: { status: "pending" },
      option: { status: "pending" },
      decay: { status: "pending" },
      synthesis: { status: "pending" },
    });

    try {
      const resp = await fetch("/api/options/agent-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRequestBody(result)),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          let evt: any;
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
          handleEvent(evt);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      reloadHistory();
    }

    function handleEvent(evt: any) {
      if (evt.event === "agent.start") {
        setAgents((prev) => ({
          ...prev,
          [evt.agent]: { ...prev[evt.agent as AgentName], status: "running", startedAt: Date.now() },
        }));
      } else if (evt.event === "agent.complete") {
        setAgents((prev) => ({
          ...prev,
          [evt.agent]: {
            status: "complete",
            output: evt.output,
            model: evt.model,
            headlines: evt.headlines,
            startedAt: prev[evt.agent as AgentName].startedAt,
            finishedAt: Date.now(),
          },
        }));
      } else if (evt.event === "agent.error") {
        setAgents((prev) => ({
          ...prev,
          [evt.agent]: {
            status: "error",
            error: evt.error,
            startedAt: prev[evt.agent as AgentName].startedAt,
            finishedAt: Date.now(),
          },
        }));
      } else if (evt.event === "run.complete") {
        setRunId(evt.run_id);
        setDurationMs(evt.duration_ms);
      } else if (evt.event === "heartbeat") {
        // Backend heartbeats fire every ~4s while parallel agents are
        // still working — we don't need to react explicitly, the
        // running cards keep their elapsed-time tickers via setInterval
        // already. The event still serves a real purpose at the HTTP
        // layer (keeps the connection alive through any proxies).
      }
    }
  }, [result, running, reloadHistory]);

  const hasAnyOutput = AGENT_ORDER.some((n) => agents[n].status !== "pending");

  // ── render ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      {/* Pipeline header — horizontal flow with arrows */}
      <PipelineHeader agents={agents} />

      {/* Run controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button size="sm" onClick={run} disabled={running} className="gap-1.5">
          {running
            ? <><Loader2 size={14} className="animate-spin" /> Running pipeline…</>
            : <><Sparkles size={14} /> {hasAnyOutput ? "Re-run pipeline" : "Run AI agents"}</>}
        </Button>
        {durationMs != null && (
          <span className="text-[10px] uppercase tracking-wider text-text-muted tabular">
            ran in {(durationMs / 1000).toFixed(1)}s
            {runId != null && <span className="ml-2">· run #{runId}</span>}
          </span>
        )}
        <span className="ml-auto text-[10px] uppercase tracking-wider text-text-muted">
          5 agents · 4 in parallel → synthesis
        </span>
      </div>

      {error && (
        <div className="rounded-md border border-down/30 bg-down/5 px-3 py-2 text-[11px] text-down">
          {error}
        </div>
      )}

      {/* Agent cards */}
      <div className="flex flex-col gap-2">
        {AGENT_ORDER.map((name) => (
          <AgentCard
            key={name}
            name={name}
            state={agents[name]}
            contextChips={buildContextChips(name, result)}
          />
        ))}
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="pt-3 border-t border-border/40">
          <div className="flex items-center gap-2 mb-2">
            <History size={12} className="text-text-muted" />
            <span className="text-[10px] uppercase tracking-wider text-text-muted font-medium">
              Recent runs on this contract
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {history.map((row) => {
              const isCurrent = row.id === runId;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => loadRun(row)}
                    className={cn(
                      "w-full flex items-center gap-3 px-2 py-1.5 rounded text-left text-[11px] tabular transition-colors hover:bg-surface-2",
                      isCurrent && "bg-surface-2",
                    )}
                  >
                    <span className="text-text-muted">#{row.id}</span>
                    <span className="text-text-secondary">{formatTime(row.ran_at)}</span>
                    {row.duration_ms != null && (
                      <span className="ml-auto text-text-muted">
                        {(row.duration_ms / 1000).toFixed(1)}s
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Pipeline header — horizontal flow visualization ───────────────────
function PipelineHeader({ agents }: { agents: Record<AgentName, AgentState> }) {
  return (
    <div className="rounded-md border border-border bg-surface-2/30 p-3">
      <div className="flex items-center gap-1 flex-wrap">
        {/* Parallel batch (in a row) */}
        <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
          {PARALLEL_AGENTS.map((name, i) => (
            <PipelineNode
              key={name}
              name={name}
              state={agents[name]}
              connect={i < PARALLEL_AGENTS.length - 1 ? "and" : "to-synth"}
            />
          ))}
        </div>
        {/* Synthesis at the end */}
        <PipelineNode name="synthesis" state={agents.synthesis} connect={null} />
      </div>
      <div className="mt-2 text-[9px] uppercase tracking-wider text-text-muted/80 leading-tight">
        4 parallel reads → coordinator synthesizes a verdict
      </div>
    </div>
  );
}

function PipelineNode({
  name, state, connect,
}: {
  name: AgentName;
  state: AgentState;
  connect: "and" | "to-synth" | null;
}) {
  const meta = AGENT_META[name];
  const Icon = meta.icon;
  const active = state.status === "running";
  const done = state.status === "complete";
  const failed = state.status === "error";
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex flex-col items-center gap-1 min-w-[58px]">
        <div
          className={cn(
            "w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all",
            active && "border-accent shadow-[0_0_0_3px_rgba(59,130,246,0.18)]",
            done && "border-up bg-up/10",
            failed && "border-down bg-down/10",
            !active && !done && !failed && "border-border bg-surface",
          )}
          style={active ? { color: meta.accent } : undefined}
        >
          {active ? (
            <Loader2 size={12} className="animate-spin text-accent" />
          ) : done ? (
            <CheckCircle2 size={14} className="text-up" />
          ) : failed ? (
            <XCircle size={14} className="text-down" />
          ) : (
            <Icon size={12} className="text-text-muted" />
          )}
        </div>
        <span className={cn(
          "text-[9px] uppercase tracking-wider leading-none",
          active ? "text-accent" : done ? "text-up" : failed ? "text-down" : "text-text-muted",
        )}>
          {meta.shortLabel}
        </span>
      </div>
      {connect === "and" && (
        <span className="text-text-muted/40 text-[14px] leading-none">+</span>
      )}
      {connect === "to-synth" && (
        <ChevronRight size={12} className="text-text-muted/60 ml-1 mr-1" />
      )}
    </div>
  );
}

// ── Agent card ────────────────────────────────────────────────────────
function AgentCard({
  name, state, contextChips,
}: {
  name: AgentName;
  state: AgentState;
  contextChips: string[];
}) {
  const meta = AGENT_META[name];
  const Icon = meta.icon;
  // Live elapsed (re-renders via the parent's setInterval tick).
  const elapsed = state.startedAt
    ? (state.finishedAt ?? Date.now()) - state.startedAt
    : null;

  return (
    <div
      className={cn(
        "rounded-md border bg-surface-2/30 overflow-hidden transition-colors",
        state.status === "running" && "border-accent/40 bg-accent/[0.03]",
        state.status === "complete" && "border-border",
        state.status === "error" && "border-down/40",
        state.status === "pending" && "border-border/60 opacity-70",
      )}
    >
      {/* Header row: icon + label + status badge + elapsed */}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Icon size={14} style={{ color: meta.accent }} className="shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-semibold text-text-primary">
              {meta.label}
            </span>
            <span className="text-[10px] text-text-muted truncate">
              {meta.desc}
            </span>
          </div>
        </div>
        {elapsed != null && (
          <span className="text-[10px] tabular text-text-muted shrink-0">
            {(elapsed / 1000).toFixed(1)}s
          </span>
        )}
        <StatusBadge status={state.status} />
      </div>

      {/* Context chips — what data the agent is reading */}
      {contextChips.length > 0 && state.status !== "pending" && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {contextChips.map((chip, i) => (
            <span
              key={i}
              className="text-[9px] tabular px-1.5 py-0.5 rounded-sm bg-surface-2/80 text-text-muted border border-border/40"
            >
              {chip}
            </span>
          ))}
        </div>
      )}

      {/* Output (only when complete) */}
      {state.status === "complete" && state.output && (
        <div className="px-3 pb-3 pt-1 border-t border-border/40">
          {name === "synthesis" ? (
            <SynthesisBody text={state.output} />
          ) : (
            <p className="text-[12px] leading-relaxed text-text-secondary whitespace-pre-line">
              {state.output}
            </p>
          )}
          {state.headlines && state.headlines.length > 0 && (
            <details className="mt-2">
              <summary className="text-[10px] uppercase tracking-wider text-text-muted cursor-pointer hover:text-text-secondary transition-colors">
                {state.headlines.length} headlines fed into this read
              </summary>
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {state.headlines.map((h, i) => (
                  <li key={i} className="text-[10px] tabular text-text-muted">
                    <a
                      href={h.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-text-secondary hover:text-text-primary transition-colors"
                    >
                      {h.title}
                    </a>
                    <span className="ml-2">— {h.source}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {state.model && (
            <div className="mt-1.5 text-[9px] uppercase tracking-wider text-text-muted/70">
              {state.model}
            </div>
          )}
        </div>
      )}

      {/* Live "thinking" indicator — bar of three pulsing dots */}
      {state.status === "running" && (
        <div className="px-3 pb-3 pt-1 flex items-center gap-1.5 border-t border-border/40">
          <span className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-1 h-1 rounded-full bg-accent animate-pulse"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
          <span className="text-[10px] tabular text-text-muted">
            reading context · waiting for OpenRouter response…
          </span>
        </div>
      )}

      {state.status === "error" && state.error && (
        <div className="px-3 pb-3 pt-1 border-t border-border/40">
          <code className="text-[10px] tabular text-down/90 break-all">{state.error}</code>
        </div>
      )}
    </div>
  );
}

// ── Synthesis body — structured render of the verdict / working / against /
//    trigger sections produced by the rebalanced synthesis prompt. Falls
//    back to plain prose if the model didn't follow the section format
//    (older runs, occasional free-model misbehavior).
function SynthesisBody({ text }: { text: string }) {
  const sections = parseSynthesisSections(text);
  if (!sections) {
    return (
      <p className="text-[12px] leading-relaxed text-text-secondary whitespace-pre-line">
        {text}
      </p>
    );
  }
  const { verdictWord, verdictRest, working, against, trigger } = sections;
  const verdictTone = verdictToneOf(verdictWord);
  return (
    <div className="flex flex-col gap-2.5">
      {/* Verdict — single colored pill + one-sentence rationale */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <span
          className={cn(
            "px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold leading-none",
            verdictTone === "up" && "bg-up/15 text-up",
            verdictTone === "down" && "bg-down/15 text-down",
            verdictTone === "warning" && "bg-warning/15 text-warning",
            verdictTone === "muted" && "bg-surface-2 text-text-secondary",
          )}
        >
          {verdictWord}
        </span>
        {verdictRest && (
          <span className="text-[12px] text-text-secondary leading-snug">
            {verdictRest}
          </span>
        )}
      </div>

      {/* Working FOR + Working AGAINST sit side by side at md+ so the
          trader sees the balance at a glance — not a wall of "risks". */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {working.length > 0 && (
          <SynthesisList items={working} tone="up" label="Working for it" />
        )}
        {against.length > 0 && (
          <SynthesisList items={against} tone="down" label="Working against it" />
        )}
      </div>

      {trigger && (
        <div className="rounded-sm border-l-2 border-accent bg-accent/[0.04] px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-wider text-accent font-semibold mb-0.5">
            Trigger
          </div>
          <div className="text-[11px] text-text-secondary tabular leading-snug">
            {trigger}
          </div>
        </div>
      )}
    </div>
  );
}

function SynthesisList({
  items, tone, label,
}: {
  items: string[];
  tone: "up" | "down";
  label: string;
}) {
  return (
    <div
      className={cn(
        "rounded-sm border-l-2 px-2 py-1.5",
        tone === "up" && "border-up bg-up/[0.04]",
        tone === "down" && "border-down bg-down/[0.04]",
      )}
    >
      <div
        className={cn(
          "text-[9px] uppercase tracking-wider font-semibold mb-1",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
        )}
      >
        {label}
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((it, i) => (
          <li
            key={i}
            className="text-[11px] text-text-secondary leading-snug tabular flex gap-1.5"
          >
            <span className="text-text-muted">·</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ParsedSynthesis {
  verdictWord: string;
  verdictRest: string;
  working: string[];
  against: string[];
  trigger: string;
}

// Parse the rebalanced synthesis output. The prompt asks for four
// labeled sections (Verdict / Working for it / Working against it /
// Trigger). Free models sometimes drop bold markers, swap order, or
// glue label + body together; the regex below is forgiving on each.
function parseSynthesisSections(raw: string): ParsedSynthesis | null {
  // Strip Markdown bold markers to simplify matching.
  const text = raw.replace(/\*\*/g, "").trim();
  // Each section starts at a label (case-insensitive) and runs until the
  // next label or end-of-string. The labels are anchored on a newline OR
  // after a leading dash/asterisk bullet that the model sometimes emits.
  const labelRe =
    /(?:^|\n)\s*(?:[-*•]\s*)?(verdict|working for it|working against it|trigger)\s*:\s*/gi;
  const positions: { label: string; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(text)) != null) {
    positions.push({
      label: m[1].toLowerCase(),
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  if (positions.length < 2) return null;
  // Slice each section's body up to the next label's start.
  const slices: Record<string, string> = {};
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : text.length;
    slices[p.label] = text.slice(p.bodyStart, end).trim();
  }

  const verdictRaw = slices["verdict"] ?? "";
  // First word of the verdict body is the action keyword.
  const verdictMatch = verdictRaw.match(/^([A-Za-z]+)\b[\s:.,—-]*([\s\S]*)$/);
  const verdictWord = (verdictMatch?.[1] ?? "").trim() || "—";
  const verdictRest = (verdictMatch?.[2] ?? "").trim();

  const working = splitBullets(slices["working for it"] ?? "");
  const against = splitBullets(slices["working against it"] ?? "");
  const trigger = (slices["trigger"] ?? "").trim();

  if (!verdictWord && working.length === 0 && against.length === 0 && !trigger) {
    return null;
  }
  return { verdictWord, verdictRest, working, against, trigger };
}

// Split a section body into bullet items. The prompt asks for 1-2
// bullets; models sometimes emit dashes, asterisks, or just newlines.
function splitBullets(body: string): string[] {
  if (!body) return [];
  return body
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0);
}

function verdictToneOf(word: string): "up" | "down" | "warning" | "muted" {
  const w = word.toLowerCase();
  if (w === "add" || w === "hold" || w === "keep") return "up";
  if (w === "close" || w === "cut" || w === "exit") return "down";
  if (w === "trim" || w === "hedge" || w === "adjust" || w === "reduce") return "warning";
  return "muted";
}

function StatusBadge({ status }: { status: AgentStatus }) {
  if (status === "pending") {
    return <span className="text-[9px] uppercase tracking-wider text-text-muted">queued</span>;
  }
  if (status === "running") {
    return (
      <span className="text-[9px] uppercase tracking-wider text-accent inline-flex items-center gap-1">
        <Loader2 size={10} className="animate-spin" />
        thinking
      </span>
    );
  }
  if (status === "complete") {
    return (
      <span className="text-[9px] uppercase tracking-wider text-up inline-flex items-center gap-1">
        <CheckCircle2 size={10} />
        done
      </span>
    );
  }
  return (
    <span className="text-[9px] uppercase tracking-wider text-down inline-flex items-center gap-1">
      <XCircle size={10} />
      failed
    </span>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

// ── Body builder — flattens the full OptionAnalyzeResult into the
//    richest payload we can send to the agents. We pack everything that
//    plausibly informs a trader's read: bid/ask, sigma ranges, per-model
//    forecast breakdown, signal-inputs across both timeframes, recent
//    OHLCV bars (sampled), full decay profile. The backend's prompt
//    builder picks each agent's slice; including it here keeps clients
//    forward-compatible if the prompts later widen.
function buildRequestBody(result: OptionAnalyzeResult) {
  const fe = result.forecast_ensemble;
  const ens5 = fe?.ensemble.horizons["5"];
  const cal = fe?.ensemble.calibration;
  const si = result.signal_inputs;
  const sigma = result.sigma_ranges;
  const liq = result.liquidity;
  const vol = result.vol_context;
  // Last ~25 bars from chart.bars — gives the model recent price
  // context without blowing up token count.
  const chartBars = result.chart?.bars ?? [];
  const recentBars = chartBars.slice(-25).map((b) => ({
    t: b.time,
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    v: b.volume,
  }));

  const side =
    `${result.is_long ? "long" : "short"}_${result.right === "C" ? "call" : "put"}`;

  return {
    // identity
    symbol: result.symbol,
    strike: result.strike,
    expiry: result.expiry,
    right: result.right,
    quantity: result.quantity,
    is_long: result.is_long,
    dte: result.dte,
    side,

    // price context
    spot: result.spot,
    breakeven: result.breakeven,
    distance_pct: result.distance_pct,
    entry_price: result.option.entry_price,
    mid: result.option.mid,
    bid: result.option.bid,
    ask: result.option.ask,
    last: result.option.last,

    // option fundamentals
    iv: result.option.iv,
    delta: result.greeks?.delta,
    gamma: result.greeks?.gamma,
    theta: result.greeks?.theta,
    vega: result.greeks?.vega,

    // underlying daily
    rsi: result.underlying?.rsi,
    macd_hist: result.underlying?.macd_hist,
    trend_score: result.underlying?.trend_score,
    ema9: result.underlying?.ema9,
    ema21: result.underlying?.ema21,
    ema50: result.underlying?.ema50,
    ema200: result.underlying?.ema200,

    // chart-TF (what's on screen in the analyzer)
    chart_tf: si?.chart_tf?.timeframe,
    chart_tf_rsi: si?.chart_tf?.rsi,
    chart_tf_macd_hist: si?.chart_tf?.macd_hist,
    chart_tf_macd_hist_prev: si?.chart_tf?.macd_hist_prev,
    chart_tf_smi: si?.chart_tf?.smi,
    chart_tf_smi_signal: si?.chart_tf?.smi_signal,
    chart_tf_vwap: si?.chart_tf?.vwap,

    // vol context
    rv30: vol?.realized_vol_30d,
    rv90: vol?.realized_vol_90d,
    iv_to_rv_ratio: vol?.iv_to_rv_ratio,

    // liquidity
    spread: liq?.spread,
    spread_pct: liq?.spread_pct,
    liquidity_grade: liq?.grade,
    volume: liq?.volume,
    open_interest: liq?.open_interest,

    // probability + sigma
    pop: result.probability?.pop,
    prob_itm: result.probability?.prob_itm,
    expected_move_pct: sigma?.expected_move_pct,
    expected_move_abs: sigma?.expected_move_abs,
    sigma1_low: sigma?.sigma1_low,
    sigma1_high: sigma?.sigma1_high,
    sigma2_low: sigma?.sigma2_low,
    sigma2_high: sigma?.sigma2_high,

    // forecast ensemble
    forecast_5d_return_pct: ens5?.expected_return_pct,
    forecast_5d_band_pct: ens5?.band_pct,
    forecast_agreement: fe?.agreement?.["5"],
    forecast_members: fe?.members,
    forecast_calibration_coverage: cal?.coverage_observed_per_h?.["5"],
    forecast_calibration_samples: cal?.samples,
    forecast_horizons_other: fe?.ensemble.horizons,

    // multi-TF + recent bars
    multi_tf: result.multi_tf,
    recommended_chart_tf: result.recommended_chart_tf,
    recent_bars: recentBars,

    // decay + risk bounds
    decay_profile: result.decay_profile,
    max_profit: result.max_profit,
    max_loss: result.max_loss,

    // rule-based scorer's existing read — the agents see what we
    // already concluded and can corroborate or contradict.
    advice_label: result.advice.label,
    advice_score: result.advice.score,
    advice_notes: result.advice.notes,
    narrative: result.narrative,
  };
}
