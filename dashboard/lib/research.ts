// Equity research desk — types + API client for /api/research/*.
// Kept separate from lib/api.ts: this feature owns its own types and an
// SSE run helper that doesn't fit the simple get/post wrappers.

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export type AssetClass = "stock" | "etf" | "crypto";
export type Depth = "quick" | "standard" | "deep";

export interface AnalystInfo {
  id: string;
  label: string;
  desc: string;
  asset_classes: AssetClass[];
}

export interface DepthInfo {
  id: Depth;
  label: string;
  desc: string;
  debate_rounds: number;
  risk_review: boolean;
}

export interface CostModel {
  per_analyst: number;
  per_debate_round: number;
  trader: number;
  risk_review: number;
  decision: number;
}

export interface ResearchCatalog {
  asset_classes: AssetClass[];
  analysts: AnalystInfo[];
  depths: DepthInfo[];
  cost_model: CostModel;
}

export interface Plan {
  id: string;
  name: string;
  price_usd_month: number;
  credits_month: number;
  blurb: string;
  features: string[];
}

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  price_usd: number;
}

export interface PricingInfo {
  plans: Plan[];
  packs: CreditPack[];
  signup_credits: number;
  example_costs: Record<Depth, number>;
}

export interface LedgerEntry {
  delta: number;
  balance_after: number;
  reason: string;
  created_at?: string;
}

export interface CreditAccount {
  user_id: string;
  plan: string;
  balance: number;
  ledger: LedgerEntry[];
}

export interface Decision {
  action: "BUY" | "SELL" | "HOLD";
  conviction: number;
  position_size_pct: number;
  time_horizon: string;
  entry_zone: string;
  stop_loss: string;
  take_profit: string;
  bull_case: string;
  bear_case: string;
  key_risks: string[];
  summary: string;
}

export interface RunRow {
  id: number;
  ran_at: string;
  symbol: string;
  asset_class: AssetClass;
  depth: Depth;
  analysts: string[];
  credits_charged: number;
  duration_ms: number | null;
  decision: Decision | null;
}

export interface SnapshotSummary {
  symbol: string;
  asset_class: string;
  name: string;
  last_close: number;
  as_of: string;
  rsi14?: number;
  ret_1m_pct?: number;
  ret_3m_pct?: number;
  rv30_annualized_pct?: number;
  dist_52w_high_pct?: number;
  [key: string]: unknown;
}

export type ResearchEvent =
  | { event: "run.start"; symbol: string; depth: Depth; analysts: string[]; cost: number; balance: number }
  | { event: "data.ready"; snapshot: SnapshotSummary }
  | { event: "agent.start"; agent: string }
  | { event: "agent.delta"; agent: string; text: string }
  | { event: "agent.complete"; agent: string; output?: string; model?: string; duration_ms?: number }
  | { event: "agent.error"; agent: string; error: string }
  | { event: "debate.round"; round: number; total: number }
  | { event: "decision"; decision: Decision }
  | { event: "run.complete"; run_id: number | null; duration_ms: number; credits_charged: number; balance: number }
  | { event: "run.error"; error: string; balance?: number }
  | { event: "heartbeat" };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail).catch(() => "");
    throw new Error(detail || `POST ${path} failed: ${res.status}`);
  }
  return res.json();
}

export interface RunDetail extends Omit<RunRow, "duration_ms"> {
  duration_ms: number | null;
  agents: Record<string, { output?: string | Decision; model?: string; duration_ms?: number; error?: string }>;
}

export const researchApi = {
  catalog: () => get<ResearchCatalog>("/api/research/catalog"),
  pricing: () => get<PricingInfo>("/api/research/pricing"),
  credits: () => get<CreditAccount>("/api/research/credits"),
  checkout: (packId: string) =>
    post<{ granted: boolean; dev_mode: boolean; pack: CreditPack; balance?: number; checkout_url?: string }>(
      "/api/research/credits/checkout",
      { pack_id: packId }
    ),
  subscribe: (planId: string) =>
    post<{ plan: string; balance: number; dev_mode: boolean }>(
      "/api/research/plan/subscribe",
      { plan_id: planId }
    ),
  runs: (limit = 20) => get<RunRow[]>(`/api/research/runs?limit=${limit}`),
  run: (id: number) => get<RunDetail>(`/api/research/runs/${id}`),
};

export function estimateCost(analysts: string[], depth: DepthInfo, cost: CostModel): number {
  let total = analysts.length * cost.per_analyst + cost.decision;
  if (depth.debate_rounds > 0) {
    total += depth.debate_rounds * cost.per_debate_round + cost.trader;
  }
  if (depth.risk_review) total += cost.risk_review;
  return total;
}

// POST the run and stream SSE frames back through `onEvent`. EventSource
// can't POST, so we read the body stream by hand (same pattern as the
// options analyzer).
export async function streamResearchRun(
  body: { symbol: string; asset_class: AssetClass; analysts: string[]; depth: Depth },
  onEvent: (evt: ResearchEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const resp = await fetch(`${BASE}/api/research/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const detail = await resp
      .json()
      .then((j) => j.detail)
      .catch(() => `HTTP ${resp.status}`);
    throw new Error(typeof detail === "string" ? detail : `HTTP ${resp.status}`);
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
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as ResearchEvent);
      } catch {
        // Ignore malformed frames — the stream stays usable.
      }
    }
  }
}
