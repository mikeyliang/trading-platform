"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Brain,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Sparkles,
  TrendingUp,
  Newspaper,
  Calculator,
  MessageSquare,
  ShieldAlert,
  Gavel,
} from "lucide-react";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AgentConfigPanel,
  type AgentConfig,
  type AgentKey,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
} from "./AgentConfigPanel";
import {
  AgentHistory,
  appendHistory,
  clearHistory,
  loadHistory,
  type HistoryEntry,
} from "./AgentHistory";
import {
  AgentStatusRail,
  type AgentRailItem,
  type AgentStatus,
} from "./AgentStatusRail";

type AgentsStatus = {
  installed: boolean;
  has_openai_key: boolean;
  has_anthropic_key: boolean;
  has_google_key: boolean;
};

type AnalyzeResult = {
  cached: boolean;
  symbol: string;
  trade_date: string;
  decision: string;
  final_state: Record<string, string>;
};

const SECTION_META: Record<
  AgentKey,
  { label: string; icon: typeof Brain; color: string; description: string }
> = {
  market_report: {
    label: "Market Analyst",
    icon: TrendingUp,
    color: "text-blue-400",
    description: "Technical indicators, trend, momentum",
  },
  sentiment_report: {
    label: "Sentiment Analyst",
    icon: Sparkles,
    color: "text-pink-400",
    description: "Reddit, StockTwits, social mood",
  },
  news_report: {
    label: "News Analyst",
    icon: Newspaper,
    color: "text-yellow-400",
    description: "Macro headlines + ticker news",
  },
  fundamentals_report: {
    label: "Fundamentals Analyst",
    icon: Calculator,
    color: "text-green-400",
    description: "Financials, earnings, valuation",
  },
  investment_debate_state: {
    label: "Bull / Bear Debate",
    icon: MessageSquare,
    color: "text-purple-400",
    description: "Researcher team — structured argumentation",
  },
  trader_investment_plan: {
    label: "Trader Plan",
    icon: Brain,
    color: "text-accent",
    description: "Position sizing + entry/exit rationale",
  },
  risk_debate_state: {
    label: "Risk Management",
    icon: ShieldAlert,
    color: "text-orange-400",
    description: "Conservative / aggressive / neutral risk views",
  },
  final_trade_decision: {
    label: "Portfolio Manager Decision",
    icon: Gavel,
    color: "text-up",
    description: "Final approve / reject + rationale",
  },
};

const SECTION_ORDER: AgentKey[] = Object.keys(SECTION_META) as AgentKey[];

export function AgentDebate() {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_CONFIG);
  const [configOpen, setConfigOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);
  const [symbol, setSymbol] = useState(DEFAULT_CONFIG.defaultSymbol);
  const [pending, setPending] = useState(DEFAULT_CONFIG.defaultSymbol);
  const [tradeDate, setTradeDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingStatus, setStreamingStatus] = useState<
    Record<AgentKey, { status: AgentStatus; durationMs?: number }>
  >(initStreamingStatus);
  const [revealed, setRevealed] = useState<Set<AgentKey>>(new Set());
  const streamTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // hydrate config + history on mount (client-only)
  useEffect(() => {
    const cfg = loadConfig();
    setConfig(cfg);
    setSymbol(cfg.defaultSymbol);
    setPending(cfg.defaultSymbol);
    setHistory(loadHistory());
  }, []);

  useEffect(() => {
    saveConfig(config);
  }, [config]);

  useEffect(() => {
    api.agentsStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  // Clean up scheduled stream timers on unmount.
  useEffect(() => {
    return () => streamTimers.current.forEach(clearTimeout);
  }, []);

  async function run(sym = symbol, date = tradeDate) {
    clearStreamTimers();
    setLoading(true);
    setError(null);
    setResult(null);
    setRevealed(new Set());
    setCurrentEntryId(null);

    // While the request is in-flight, every focused agent is "thinking".
    const initial: Record<AgentKey, { status: AgentStatus; durationMs?: number }> =
      initStreamingStatus();
    for (const key of SECTION_ORDER) {
      initial[key] = {
        status: config.focused[key] ? "thinking" : "idle",
      };
    }
    setStreamingStatus(initial);

    const startedAt = performance.now();
    try {
      const r = await api.agentsAnalyze(sym, date);
      const duration = performance.now() - startedAt;
      setResult(r);
      scheduleStreamReveal(r, duration);
      const entry: HistoryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ran_at: new Date().toISOString(),
        symbol: r.symbol,
        trade_date: r.trade_date,
        decision: r.decision,
        duration_ms: Math.round(duration),
        final_state: r.final_state || {},
      };
      setHistory(appendHistory(entry));
      setCurrentEntryId(entry.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Mark every "thinking" agent as errored so the UI doesn't dangle.
      setStreamingStatus((prev) => {
        const next = { ...prev };
        for (const key of SECTION_ORDER) {
          if (next[key]?.status === "thinking") next[key] = { status: "error" };
        }
        return next;
      });
    } finally {
      setLoading(false);
    }
  }

  function clearStreamTimers() {
    streamTimers.current.forEach(clearTimeout);
    streamTimers.current = [];
  }

  function scheduleStreamReveal(r: AnalyzeResult, totalDurationMs: number) {
    // Walk through agents in canonical order. Each agent goes
    // thinking → responding → done with a small delay to mimic
    // a real streaming pipeline. Only sections the model actually
    // returned (and that aren't muted via the config) are revealed.
    const present = SECTION_ORDER.filter(
      (key) => r.final_state?.[key] && config.focused[key]
    );
    const per = Math.max(config.streamingSpeedMs, 50);
    const respondingLead = Math.max(80, Math.floor(per * 0.4));
    const perAgentDuration = totalDurationMs / Math.max(present.length, 1);

    present.forEach((key, idx) => {
      const respondAt = idx * per;
      const doneAt = respondAt + respondingLead;
      streamTimers.current.push(
        setTimeout(() => {
          setStreamingStatus((prev) => ({
            ...prev,
            [key]: { status: "responding" },
          }));
        }, respondAt)
      );
      streamTimers.current.push(
        setTimeout(() => {
          setStreamingStatus((prev) => ({
            ...prev,
            [key]: {
              status: "done",
              durationMs: Math.round(perAgentDuration),
            },
          }));
          setRevealed((prev) => {
            const next = new Set(prev);
            next.add(key);
            return next;
          });
        }, doneAt)
      );
    });

    // Anything focused but missing from the response: mark as idle.
    SECTION_ORDER.filter(
      (key) => config.focused[key] && !r.final_state?.[key]
    ).forEach((key) => {
      setStreamingStatus((prev) => ({ ...prev, [key]: { status: "idle" } }));
    });
  }

  function loadFromHistory(entry: HistoryEntry) {
    clearStreamTimers();
    setError(null);
    setLoading(false);
    setSymbol(entry.symbol);
    setPending(entry.symbol);
    setTradeDate(entry.trade_date);
    const restored: AnalyzeResult = {
      cached: true,
      symbol: entry.symbol,
      trade_date: entry.trade_date,
      decision: entry.decision,
      final_state: entry.final_state,
    };
    setResult(restored);
    setCurrentEntryId(entry.id);
    const next: Record<AgentKey, { status: AgentStatus; durationMs?: number }> =
      initStreamingStatus();
    const revealedSet = new Set<AgentKey>();
    for (const key of SECTION_ORDER) {
      if (entry.final_state?.[key]) {
        next[key] = { status: "done" };
        revealedSet.add(key);
      }
    }
    setStreamingStatus(next);
    setRevealed(revealedSet);
  }

  function onClearHistory() {
    setHistory(clearHistory());
    setCurrentEntryId(null);
  }

  const hasAnyLLMKey =
    status?.has_openai_key || status?.has_anthropic_key || status?.has_google_key;

  const runDebate = () => {
    setSymbol(pending);
    run(pending, tradeDate);
  };

  const railItems: AgentRailItem[] = useMemo(
    () =>
      SECTION_ORDER.filter((key) => config.focused[key]).map((key) => ({
        key,
        label: SECTION_META[key].label,
        status: streamingStatus[key]?.status ?? "idle",
        durationMs: streamingStatus[key]?.durationMs,
      })),
    [config.focused, streamingStatus]
  );

  return (
    <PageShell>
      <PageHeader
        eyebrow="Agents"
        title="Multi-Agent Debate"
        description="LLM analysts debate a ticker — market, sentiment, news, fundamentals — then bull/bear, trader, risk, and a final PM decision."
        actions={
          <div className="flex items-end gap-2 flex-wrap">
            <Field label="Ticker">
              <Input
                value={pending}
                onChange={(e) => setPending(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runDebate();
                }}
                placeholder="RUT"
                className="h-7 w-20 uppercase tabular"
              />
            </Field>
            <Field label="As-of date">
              <Input
                type="date"
                value={tradeDate}
                onChange={(e) => setTradeDate(e.target.value)}
                className="h-7 tabular"
              />
            </Field>
            <Button
              onClick={runDebate}
              disabled={loading || !status?.installed || !hasAnyLLMKey}
              variant="default"
              size="sm"
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              {loading ? "Debating…" : "Run debate"}
            </Button>
          </div>
        }
      />

      <StatusBanner status={status} hasAnyLLMKey={!!hasAnyLLMKey} />

      <AgentConfigPanel
        config={config}
        onChange={setConfig}
        open={configOpen}
        onToggle={() => setConfigOpen((v) => !v)}
      />

      {config.showAgentChips && railItems.length > 0 && (
        <AgentStatusRail items={railItems} />
      )}

      {result?.cached && (
        <div className="text-[11px] text-text-muted">
          Cached (1hr TTL) — re-runs are free.
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-2 rounded border border-down/30 bg-down/5 text-[11px]">
          <AlertCircle size={12} className="text-down shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-down">Run failed</div>
            <div className="text-text-secondary mt-0.5 font-mono text-[11px]">{error}</div>
          </div>
        </div>
      )}

      {loading && (
        <div className="p-3 rounded border border-border bg-surface text-[11px] text-text-muted text-center">
          Running multi-agent debate — this takes 30–90s depending on model and
          rounds. Each analyst makes 1–2 LLM calls, then bull/bear debate runs
          for up to max_debate_rounds.
        </div>
      )}

      {result && <DecisionBanner result={result} />}

      {result && (
        <div className="grid gap-2">
          {SECTION_ORDER.map((key) => {
            if (!config.focused[key]) return null;
            const content = result.final_state[key];
            if (!content) return null;
            const isRevealed = revealed.has(key);
            return (
              <ReportSection
                key={key}
                sectionKey={key}
                content={content}
                visible={isRevealed}
                forceExpanded={config.autoExpandSections}
              />
            );
          })}
        </div>
      )}

      <AgentHistory
        history={history}
        onSelect={loadFromHistory}
        onClear={onClearHistory}
        currentId={currentEntryId}
      />
    </PageShell>
  );
}

function initStreamingStatus(): Record<
  AgentKey,
  { status: AgentStatus; durationMs?: number }
> {
  return SECTION_ORDER.reduce(
    (acc, key) => {
      acc[key] = { status: "idle" };
      return acc;
    },
    {} as Record<AgentKey, { status: AgentStatus; durationMs?: number }>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-text-muted uppercase tracking-wider">{label}</span>
      {children}
    </label>
  );
}

function StatusBanner({
  status,
  hasAnyLLMKey,
}: {
  status: AgentsStatus | null;
  hasAnyLLMKey: boolean;
}) {
  if (!status) {
    return (
      <div className="p-3 rounded border border-border bg-surface-2 text-sm text-text-muted">
        Checking TradingAgents availability…
      </div>
    );
  }
  if (!status.installed) {
    return (
      <div className="p-3 rounded border border-down/30 bg-down/5 text-sm flex items-start gap-2">
        <XCircle size={16} className="text-down shrink-0 mt-0.5" />
        <div>
          <div className="font-medium text-down">TradingAgents not installed</div>
          <div className="text-text-secondary mt-0.5">
            Run <code className="text-xs">pip install -e ../tradingagents</code>{" "}
            in the api service to enable.
          </div>
        </div>
      </div>
    );
  }
  if (!hasAnyLLMKey) {
    return (
      <div className="p-3 rounded border border-warning/30 bg-warning/5 text-sm flex items-start gap-2">
        <AlertCircle size={16} className="text-warning shrink-0 mt-0.5" />
        <div>
          <div className="font-medium text-warning">No LLM API key configured</div>
          <div className="text-text-secondary mt-0.5">
            Set <code className="text-xs">OPENAI_API_KEY</code>,{" "}
            <code className="text-xs">ANTHROPIC_API_KEY</code>, or{" "}
            <code className="text-xs">GOOGLE_API_KEY</code> in{" "}
            <code className="text-xs">services/api/.env</code> and restart the API.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      <KeyChip label="OpenAI" present={status.has_openai_key} />
      <KeyChip label="Anthropic" present={status.has_anthropic_key} />
      <KeyChip label="Google" present={status.has_google_key} />
    </div>
  );
}

function KeyChip({ label, present }: { label: string; present: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 px-2 py-1 rounded border text-xs",
        present
          ? "border-up/30 bg-up/5 text-up"
          : "border-border bg-surface-2 text-text-muted"
      )}
    >
      {present ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
      {label}
    </span>
  );
}

function DecisionBanner({ result }: { result: AnalyzeResult }) {
  const decision = (result.decision || "").trim();
  const decisionLower = decision.toLowerCase();
  const tone = decisionLower.includes("buy")
    ? "up"
    : decisionLower.includes("sell")
    ? "down"
    : "neutral";

  return (
    <div
      className={cn(
        "p-5 rounded-lg border-2",
        tone === "up"
          ? "border-up/40 bg-up/5"
          : tone === "down"
          ? "border-down/40 bg-down/5"
          : "border-border bg-surface"
      )}
    >
      <div className="text-xs uppercase tracking-wider text-text-muted mb-1">
        Final decision · {result.symbol} · {result.trade_date}
      </div>
      <div
        className={cn(
          "text-2xl font-semibold",
          tone === "up"
            ? "text-up"
            : tone === "down"
            ? "text-down"
            : "text-text-primary"
        )}
      >
        {decision || "(no decision returned)"}
      </div>
    </div>
  );
}

function ReportSection({
  sectionKey,
  content,
  visible,
  forceExpanded,
}: {
  sectionKey: AgentKey;
  content: string | object;
  visible: boolean;
  forceExpanded: boolean;
}) {
  const meta = SECTION_META[sectionKey];
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const defaultExpanded =
    forceExpanded ||
    sectionKey === "final_trade_decision" ||
    sectionKey === "trader_investment_plan";
  const expanded = userExpanded ?? defaultExpanded;

  const Icon = meta?.icon ?? Brain;
  const accent = meta?.color ?? "text-text-secondary";
  const label = meta?.label ?? sectionKey;

  // Debate states arrive as objects; render their string fields plainly.
  const text =
    typeof content === "string"
      ? content
      : JSON.stringify(content, null, 2);

  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-surface overflow-hidden transition-all",
        visible ? "opacity-100 translate-y-0" : "opacity-40 translate-y-1"
      )}
    >
      <button
        onClick={() => setUserExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-surface-2/40"
      >
        <div className="flex items-center gap-3">
          <Icon size={18} className={accent} />
          <div className="text-left">
            <div className={cn("font-medium", accent)}>{label}</div>
            {meta?.description && (
              <div className="text-xs text-text-muted">{meta.description}</div>
            )}
          </div>
        </div>
        <span className="text-xs text-text-muted">
          {expanded ? "Hide" : "Show"}
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-border">
          <pre className="text-sm text-text-secondary whitespace-pre-wrap font-sans leading-relaxed">
            {text}
          </pre>
        </div>
      )}
    </section>
  );
}
