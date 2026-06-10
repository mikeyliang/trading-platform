"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import {
  Bitcoin, Brain, CandlestickChart, CheckCircle2, Coins, CreditCard, Landmark,
  LineChart, Loader2, Newspaper, Scale, ShieldAlert, Sparkles, Swords,
  TrendingUp, Users, XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  type AssetClass, type CreditAccount, type Decision, type Depth,
  type ResearchCatalog, type ResearchEvent, type RunRow, type SnapshotSummary,
  estimateCost, researchApi, streamResearchRun,
} from "@/lib/research";

type AgentStatus = "running" | "complete" | "error";

interface AgentState {
  status: AgentStatus;
  text: string;
  model?: string;
  durationMs?: number;
  error?: string;
}

const ANALYST_ICONS: Record<string, typeof LineChart> = {
  market: CandlestickChart,
  fundamentals: Landmark,
  news: Newspaper,
  sentiment: Users,
  onchain: Coins,
};

const ASSET_LABELS: Record<AssetClass, { label: string; icon: typeof LineChart }> = {
  stock: { label: "Stock", icon: TrendingUp },
  etf: { label: "ETF", icon: LineChart },
  crypto: { label: "Crypto", icon: Bitcoin },
};

function agentMeta(key: string, catalog: ResearchCatalog | null): { label: string; icon: typeof LineChart } {
  const analyst = catalog?.analysts.find((a) => a.id === key);
  if (analyst) return { label: analyst.label, icon: ANALYST_ICONS[key] ?? LineChart };
  const debate = key.match(/^(bull|bear)_r(\d+)$/);
  if (debate) {
    return {
      label: `${debate[1] === "bull" ? "Bull" : "Bear"} Researcher · round ${debate[2]}`,
      icon: Swords,
    };
  }
  if (key === "trader") return { label: "Trader", icon: Scale };
  if (key === "risk") return { label: "Risk Manager", icon: ShieldAlert };
  if (key === "portfolio_manager") return { label: "Portfolio Manager", icon: Brain };
  return { label: key, icon: LineChart };
}

export function ResearchDesk() {
  const [catalog, setCatalog] = useState<ResearchCatalog | null>(null);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [history, setHistory] = useState<RunRow[]>([]);

  const [assetClass, setAssetClass] = useState<AssetClass>("stock");
  const [symbol, setSymbol] = useState("");
  const [selected, setSelected] = useState<string[]>(["market", "news", "sentiment"]);
  const [depth, setDepth] = useState<Depth>("standard");

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotSummary | null>(null);
  const [agentOrder, setAgentOrder] = useState<string[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentState>>({});
  const [decision, setDecision] = useState<Decision | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reloadAccount = useCallback(() => {
    researchApi.credits().then(setAccount).catch(() => {});
    researchApi.runs().then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    researchApi.catalog().then(setCatalog).catch(() => {});
    reloadAccount();
    return () => abortRef.current?.abort();
  }, [reloadAccount]);

  const availableAnalysts = useMemo(
    () => (catalog?.analysts ?? []).filter((a) => a.asset_classes.includes(assetClass)),
    [catalog, assetClass]
  );

  const depthInfo = useMemo(
    () => catalog?.depths.find((d) => d.id === depth) ?? null,
    [catalog, depth]
  );

  const cost = useMemo(() => {
    if (!catalog || !depthInfo) return null;
    const valid = selected.filter((s) => availableAnalysts.some((a) => a.id === s));
    if (valid.length === 0) return null;
    return estimateCost(valid, depthInfo, catalog.cost_model);
  }, [catalog, depthInfo, selected, availableAnalysts]);

  const toggleAnalyst = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  const handleEvent = useCallback((evt: ResearchEvent) => {
    switch (evt.event) {
      case "run.start":
        setAccount((prev) => (prev ? { ...prev, balance: evt.balance } : prev));
        break;
      case "data.ready":
        setSnapshot(evt.snapshot);
        break;
      case "agent.start":
        setAgentOrder((prev) => (prev.includes(evt.agent) ? prev : [...prev, evt.agent]));
        setAgents((prev) => ({ ...prev, [evt.agent]: { status: "running", text: "" } }));
        break;
      case "agent.delta":
        setAgents((prev) => ({
          ...prev,
          [evt.agent]: {
            ...(prev[evt.agent] ?? { status: "running" as const, text: "" }),
            text: (prev[evt.agent]?.text ?? "") + evt.text,
          },
        }));
        break;
      case "agent.complete":
        setAgents((prev) => ({
          ...prev,
          [evt.agent]: {
            status: "complete",
            text: evt.output ?? prev[evt.agent]?.text ?? "",
            model: evt.model,
            durationMs: evt.duration_ms,
          },
        }));
        break;
      case "agent.error":
        setAgents((prev) => ({
          ...prev,
          [evt.agent]: { status: "error", text: prev[evt.agent]?.text ?? "", error: evt.error },
        }));
        break;
      case "decision":
        setDecision(evt.decision);
        break;
      case "run.complete":
        setAccount((prev) => (prev ? { ...prev, balance: evt.balance } : prev));
        break;
      case "run.error":
        setError(evt.error);
        if (evt.balance != null) {
          setAccount((prev) => (prev ? { ...prev, balance: evt.balance! } : prev));
        }
        break;
      default:
        break;
    }
  }, []);

  const run = useCallback(async () => {
    if (running || !symbol.trim()) return;
    const valid = selected.filter((s) => availableAnalysts.some((a) => a.id === s));
    if (valid.length === 0) return;
    setRunning(true);
    setError(null);
    setSnapshot(null);
    setAgentOrder([]);
    setAgents({});
    setDecision(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamResearchRun(
        { symbol: symbol.trim().toUpperCase(), asset_class: assetClass, analysts: valid, depth },
        handleEvent,
        controller.signal
      );
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRunning(false);
      reloadAccount();
    }
  }, [running, symbol, selected, availableAnalysts, assetClass, depth, handleEvent, reloadAccount]);

  return (
    <div className="p-4 space-y-4 max-w-6xl mx-auto">
      {/* header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-accent" />
            <h1 className="text-base font-semibold text-text-primary">Equity Research</h1>
          </div>
          <p className="text-xs text-text-secondary mt-0.5">
            Multi-agent analysis for stocks, ETFs and crypto — analyst team, bull/bear debate, risk review, final call.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="accent" className="text-xs normal-case tracking-normal px-2 py-1">
            <CreditCard size={11} />
            {account ? `${account.balance} credits` : "…"}
          </Badge>
          <Button asChild variant="outline" size="sm">
            <Link href="/research/pricing">Pricing &amp; top-up</Link>
          </Button>
        </div>
      </div>

      {/* run form */}
      <Card>
        <CardContent className="pt-4 space-y-4">
          <div className="flex flex-wrap gap-4 items-end">
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-text-muted">Asset class</div>
              <div className="flex gap-1">
                {(Object.keys(ASSET_LABELS) as AssetClass[]).map((ac) => {
                  const { label, icon: Icon } = ASSET_LABELS[ac];
                  return (
                    <Button
                      key={ac}
                      size="sm"
                      variant={assetClass === ac ? "default" : "outline"}
                      onClick={() => setAssetClass(ac)}
                      disabled={running}
                    >
                      <Icon size={12} /> {label}
                    </Button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-text-muted">
                {assetClass === "crypto" ? "Token (e.g. BTC, ETH, SOL)" : "Ticker (e.g. AAPL, SPY)"}
              </div>
              <Input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && run()}
                placeholder={assetClass === "crypto" ? "BTC" : "AAPL"}
                className="w-36 font-mono"
                disabled={running}
              />
            </div>
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-text-muted">Depth</div>
              <div className="flex gap-1">
                {(catalog?.depths ?? []).map((d) => (
                  <Button
                    key={d.id}
                    size="sm"
                    variant={depth === d.id ? "default" : "outline"}
                    onClick={() => setDepth(d.id)}
                    disabled={running}
                    title={d.desc}
                  >
                    {d.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-3">
              {cost != null && (
                <span className="text-xs text-text-secondary">
                  Cost: <span className="text-text-primary font-medium">{cost} credits</span>
                </span>
              )}
              <Button
                onClick={run}
                disabled={running || !symbol.trim() || cost == null || (account != null && cost != null && account.balance < cost)}
                variant="default"
              >
                {running ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {running ? "Running…" : "Run analysis"}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wider text-text-muted">Research agents</div>
            <div className="flex flex-wrap gap-1.5">
              {availableAnalysts.map((a) => {
                const Icon = ANALYST_ICONS[a.id] ?? LineChart;
                const active = selected.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggleAnalyst(a.id)}
                    disabled={running}
                    title={a.desc}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                      active
                        ? "border-accent/50 bg-accent/10 text-text-primary"
                        : "border-border bg-surface text-text-secondary hover:bg-surface-2"
                    )}
                  >
                    <Icon size={12} className={active ? "text-accent" : undefined} />
                    {a.label}
                  </button>
                );
              })}
            </div>
            {depthInfo && (
              <p className="text-[11px] text-text-muted">
                {depthInfo.desc}
                {account != null && cost != null && account.balance < cost && (
                  <span className="text-down"> — not enough credits, top up on the pricing page.</span>
                )}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-down/30 bg-down/10 px-3 py-2 text-xs text-down">
          <XCircle size={13} /> {error}
        </div>
      )}

      {/* market snapshot */}
      {snapshot && (
        <div className="flex flex-wrap gap-2 text-[11px] text-text-secondary">
          <Badge variant="muted">last {fmtNum(snapshot.last_close)}</Badge>
          {snapshot.rsi14 != null && <Badge variant="muted">RSI {Number(snapshot.rsi14).toFixed(0)}</Badge>}
          {snapshot.ret_1m_pct != null && (
            <Badge variant={Number(snapshot.ret_1m_pct) >= 0 ? "up" : "down"}>
              1m {Number(snapshot.ret_1m_pct).toFixed(1)}%
            </Badge>
          )}
          {snapshot.ret_3m_pct != null && (
            <Badge variant={Number(snapshot.ret_3m_pct) >= 0 ? "up" : "down"}>
              3m {Number(snapshot.ret_3m_pct).toFixed(1)}%
            </Badge>
          )}
          {snapshot.rv30_annualized_pct != null && (
            <Badge variant="muted">RV30 {Number(snapshot.rv30_annualized_pct).toFixed(0)}%</Badge>
          )}
          {snapshot.dist_52w_high_pct != null && (
            <Badge variant="muted">vs 52w-hi {Number(snapshot.dist_52w_high_pct).toFixed(1)}%</Badge>
          )}
          <span className="self-center text-text-muted">as of {snapshot.as_of}</span>
        </div>
      )}

      {/* streaming agents */}
      {agentOrder.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {agentOrder.map((key) => {
            const state = agents[key];
            const { label, icon: Icon } = agentMeta(key, catalog);
            if (!state) return null;
            return (
              <Card key={key} className={cn(key === "portfolio_manager" && "md:col-span-2")}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-xs">
                    <Icon size={13} className="text-accent" />
                    {label}
                    <span className="ml-auto flex items-center gap-1.5 text-[10px] font-normal text-text-muted">
                      {state.durationMs != null && `${(state.durationMs / 1000).toFixed(1)}s`}
                      {state.status === "running" && <Loader2 size={11} className="animate-spin text-accent" />}
                      {state.status === "complete" && <CheckCircle2 size={11} className="text-up" />}
                      {state.status === "error" && <XCircle size={11} className="text-down" />}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {state.error ? (
                    <p className="text-xs text-down">{state.error}</p>
                  ) : (
                    <div className="prose prose-invert prose-xs max-w-none text-xs text-text-secondary leading-relaxed [&_p]:my-1">
                      <ReactMarkdown>{state.text || "…"}</ReactMarkdown>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* final decision */}
      {decision && <DecisionCard decision={decision} />}

      {/* history */}
      {history.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Recent runs</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="divide-y divide-border/60">
              {history.map((r) => (
                <div key={r.id} className="flex items-center gap-3 py-1.5 text-xs">
                  <span className="font-mono text-text-primary w-16">{r.symbol}</span>
                  <Badge variant="muted">{r.asset_class}</Badge>
                  <span className="text-text-muted">{r.depth}</span>
                  {r.decision && (
                    <Badge variant={r.decision.action === "BUY" ? "up" : r.decision.action === "SELL" ? "down" : "warning"}>
                      {r.decision.action} {r.decision.conviction}%
                    </Badge>
                  )}
                  <span className="ml-auto text-text-muted">
                    {r.credits_charged} cr · {new Date(r.ran_at).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function fmtNum(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function DecisionCard({ decision }: { decision: Decision }) {
  const actionVariant = decision.action === "BUY" ? "up" : decision.action === "SELL" ? "down" : "warning";
  return (
    <Card className="border-accent/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Brain size={14} className="text-accent" />
          Final decision
          <Badge variant={actionVariant} className="text-xs">{decision.action}</Badge>
          <span className="text-[11px] font-normal text-text-muted">
            conviction {decision.conviction}/100 · size {decision.position_size_pct}% · {decision.time_horizon}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3 text-xs">
        <p className="text-text-primary leading-relaxed">{decision.summary}</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <LevelBox label="Entry zone" value={decision.entry_zone} />
          <LevelBox label="Stop loss" value={decision.stop_loss} />
          <LevelBox label="Take profit" value={decision.take_profit} />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border border-up/30 bg-up/5 p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-up mb-1">Bull case</div>
            <p className="text-text-secondary leading-relaxed">{decision.bull_case}</p>
          </div>
          <div className="rounded-md border border-down/30 bg-down/5 p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-down mb-1">Bear case</div>
            <p className="text-text-secondary leading-relaxed">{decision.bear_case}</p>
          </div>
        </div>
        {decision.key_risks.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">Key risks</div>
            <ul className="space-y-0.5 text-text-secondary">
              {decision.key_risks.map((r, i) => (
                <li key={i} className="flex gap-1.5">
                  <ShieldAlert size={11} className="mt-0.5 shrink-0 text-warning" /> {r}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-[10px] text-text-muted">
          AI-generated research, not financial advice.
        </p>
      </CardContent>
    </Card>
  );
}

function LevelBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-0.5">{label}</div>
      <div className="text-text-primary font-medium">{value}</div>
    </div>
  );
}
