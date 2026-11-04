"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  RiBrainLine,
  RiPlayFill,
  RiLoader4Line,
  RiErrorWarningFill,
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiStockLine,
  RiNewspaperLine,
  RiCalculatorLine,
  RiChat1Line,
  RiShieldFlashLine,
  RiAuctionLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton, Spinner } from "@/components/ui/skeleton";
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
  { label: string; icon: RemixiconComponentType; description: string }
> = {
  market_report: {
    label: "Market analyst",
    icon: RiStockLine,
    description: "Technical indicators, trend, momentum",
  },
  sentiment_report: {
    label: "Sentiment analyst",
    icon: RiBrainLine,
    description: "Reddit, StockTwits, social mood",
  },
  news_report: {
    label: "News analyst",
    icon: RiNewspaperLine,
    description: "Macro headlines and ticker news",
  },
  fundamentals_report: {
    label: "Fundamentals analyst",
    icon: RiCalculatorLine,
    description: "Financials, earnings, valuation",
  },
  investment_debate_state: {
    label: "Bull and bear debate",
    icon: RiChat1Line,
    description: "Researcher team, structured argumentation",
  },
  trader_investment_plan: {
    label: "Trader plan",
    icon: RiBrainLine,
    description: "Position sizing, entry and exit rationale",
  },
  risk_debate_state: {
    label: "Risk management",
    icon: RiShieldFlashLine,
    description: "Conservative, aggressive and neutral risk views",
  },
  final_trade_decision: {
    label: "Portfolio manager decision",
    icon: RiAuctionLine,
    description: "Final approve or reject with rationale",
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
        title="Multi-agent debate"
        description="LLM analysts debate a ticker: market, sentiment, news and fundamentals, then bull and bear, trader, risk and a final PM decision."
        actions={
          <div className="flex items-end gap-3 flex-wrap">
            <Field label="Ticker">
              <Input
                value={pending}
                onChange={(e) => setPending(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runDebate();
                }}
                placeholder="RUT"
                className="w-24 tabular"
              />
            </Field>
            <Field label="As-of date">
              <Input
                type="date"
                value={tradeDate}
                onChange={(e) => setTradeDate(e.target.value)}
                className="w-40 tabular"
              />
            </Field>
            <Button
              onClick={runDebate}
              disabled={loading || !status?.installed || !hasAnyLLMKey}
              variant="default"
            >
              {loading ? <RiLoader4Line className="animate-spin" /> : <RiPlayFill />}
              {loading ? "Debating" : "Run debate"}
            </Button>
          </div>
        }
      />

      <StatusCard status={status} hasAnyLLMKey={!!hasAnyLLMKey} />

      <AgentConfigPanel
        config={config}
        onChange={setConfig}
        open={configOpen}
        onToggle={() => setConfigOpen((v) => !v)}
      />

      {config.showAgentChips && railItems.length > 0 && (
        <AgentStatusRail items={railItems} />
      )}

      {error && (
        <Card className="shrink-0">
          <CardContent>
            <div className="rounded-2lg bg-status-rose-background text-status-rose-text px-3 py-2 flex items-start gap-2 text-body-2-regular">
              <RiErrorWarningFill size={16} className="shrink-0 mt-0.5" aria-hidden />
              <div className="min-w-0">
                <div className="text-body-2-medium">Run failed</div>
                <div className="tabular break-words">{error}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {loading && (
        <Card className="shrink-0">
          <div role="status" aria-live="polite" className="flex flex-col items-center gap-2 py-10 px-6 text-center">
            <Spinner size={18} />
            <span className="text-body-medium text-text-primary">Running the debate</span>
            <span className="text-body-2-regular text-text-tertiary max-w-md">
              This takes 30 to 90 seconds depending on model and rounds. Each analyst makes one or two
              LLM calls, then the bull and bear debate runs for up to the configured number of rounds.
            </span>
          </div>
        </Card>
      )}

      {result && <DecisionCard result={result} />}

      {result && (
        <div className="flex flex-col gap-3 shrink-0">
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
    <label className="flex flex-col gap-1.5">
      <span className="text-caption-1-medium text-text-tertiary">{label}</span>
      {children}
    </label>
  );
}

function StatusCard({
  status,
  hasAnyLLMKey,
}: {
  status: AgentsStatus | null;
  hasAnyLLMKey: boolean;
}) {
  const badge = !status
    ? null
    : !status.installed
    ? <Badge variant="down">Not installed</Badge>
    : !hasAnyLLMKey
    ? <Badge variant="warning">No API key</Badge>
    : <Badge variant="up">Ready</Badge>;

  return (
    <Card className="shrink-0">
      <CardHeader>
        <CardTitle>TradingAgents service</CardTitle>
        {badge}
      </CardHeader>
      <CardContent>
        {!status ? (
          <div className="flex items-center gap-3" role="status" aria-label="Checking TradingAgents availability">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-24" />
          </div>
        ) : !status.installed ? (
          <div className="rounded-2lg bg-status-rose-background text-status-rose-text px-3 py-2 flex items-start gap-2 text-body-2-regular">
            <RiErrorWarningFill size={16} className="shrink-0 mt-0.5" aria-hidden />
            <div>
              <div className="text-body-2-medium">TradingAgents is not installed</div>
              <div>
                Run <code className="tabular">pip install -e ../tradingagents</code> in the api service to enable it.
              </div>
            </div>
          </div>
        ) : !hasAnyLLMKey ? (
          <div className="rounded-2lg bg-status-yellow-background text-status-yellow-text px-3 py-2 flex items-start gap-2 text-body-2-regular">
            <RiErrorWarningFill size={16} className="shrink-0 mt-0.5" aria-hidden />
            <div>
              <div className="text-body-2-medium">No LLM API key configured</div>
              <div>
                Set <code className="tabular">OPENAI_API_KEY</code>, <code className="tabular">ANTHROPIC_API_KEY</code> or{" "}
                <code className="tabular">GOOGLE_API_KEY</code> in <code className="tabular">services/api/.env</code> and restart the API.
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption-1-medium text-text-tertiary">Keys</span>
            <KeyChip label="OpenAI" present={status.has_openai_key} />
            <KeyChip label="Anthropic" present={status.has_anthropic_key} />
            <KeyChip label="Google" present={status.has_google_key} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function KeyChip({ label, present }: { label: string; present: boolean }) {
  return (
    <Badge variant={present ? "up" : "muted"}>
      {present ? <RiCheckboxCircleFill size={14} aria-hidden /> : <RiCloseCircleFill size={14} aria-hidden />}
      {label}
    </Badge>
  );
}

function DecisionCard({ result }: { result: AnalyzeResult }) {
  const decision = (result.decision || "").trim();
  const decisionLower = decision.toLowerCase();
  const tone = decisionLower.includes("buy")
    ? "up"
    : decisionLower.includes("sell")
    ? "down"
    : "neutral";

  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Final decision</CardTitle>
          <Badge variant="muted" className="tabular">{result.symbol}</Badge>
          <span className="text-caption-1-regular tabular text-text-tertiary">{result.trade_date}</span>
        </div>
        {result.cached && <Badge variant="muted">Cached, 1h TTL</Badge>}
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "rounded-2lg px-4 py-3 text-title-2-semibold",
            tone === "up" && "bg-status-lime-background text-status-lime-text",
            tone === "down" && "bg-status-rose-background text-status-rose-text",
            tone === "neutral" && "bg-background-secondary-default text-text-primary"
          )}
        >
          {decision || "No decision returned"}
        </div>
      </CardContent>
    </Card>
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

  const Icon = meta?.icon ?? RiBrainLine;
  const label = meta?.label ?? sectionKey;

  // Debate states arrive as objects; render their string fields plainly.
  const text =
    typeof content === "string"
      ? content
      : JSON.stringify(content, null, 2);

  return (
    <Card className={cn("shrink-0 transition-opacity", visible ? "opacity-100" : "opacity-40")}>
      <button
        type="button"
        onClick={() => setUserExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-3 px-4 h-11 hover:bg-background-secondary-hover transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-button-default-focus-ring"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Icon size={18} className="text-foreground-icon-secondary shrink-0" aria-hidden />
          <span className="text-body-semibold text-text-primary truncate">{label}</span>
          {meta?.description && (
            <span className="text-caption-1-regular text-text-tertiary truncate hidden sm:inline">{meta.description}</span>
          )}
        </div>
        <span className="inline-flex items-center gap-1 text-caption-1-medium text-text-tertiary shrink-0">
          {expanded ? "Hide" : "Show"}
          {expanded ? <RiArrowDownSLine size={16} aria-hidden /> : <RiArrowRightSLine size={16} aria-hidden />}
        </span>
      </button>
      {expanded && (
        <CardContent className="border-t border-separator-border">
          <pre className="text-body-2-regular text-text-secondary whitespace-pre-wrap font-sans">
            {text}
          </pre>
        </CardContent>
      )}
    </Card>
  );
}
