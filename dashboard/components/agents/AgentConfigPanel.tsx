"use client";

import { RiArrowDownSLine, RiArrowRightSLine, RiArrowGoBackLine } from "@remixicon/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export type AgentKey =
  | "market_report"
  | "sentiment_report"
  | "news_report"
  | "fundamentals_report"
  | "investment_debate_state"
  | "trader_investment_plan"
  | "risk_debate_state"
  | "final_trade_decision";

export interface AgentConfig {
  defaultSymbol: string;
  focused: Record<AgentKey, boolean>;
  autoExpandSections: boolean;
  streamingSpeedMs: number;
  showAgentChips: boolean;
}

export const DEFAULT_CONFIG: AgentConfig = {
  defaultSymbol: "RUT",
  focused: {
    market_report: true,
    sentiment_report: true,
    news_report: true,
    fundamentals_report: true,
    investment_debate_state: true,
    trader_investment_plan: true,
    risk_debate_state: true,
    final_trade_decision: true,
  },
  autoExpandSections: false,
  streamingSpeedMs: 350,
  showAgentChips: true,
};

const AGENT_LABELS: Record<AgentKey, string> = {
  market_report: "Market",
  sentiment_report: "Sentiment",
  news_report: "News",
  fundamentals_report: "Fundamentals",
  investment_debate_state: "Bull/Bear",
  trader_investment_plan: "Trader",
  risk_debate_state: "Risk",
  final_trade_decision: "PM decision",
};

const STORAGE_KEY = "agentDebateConfig.v1";

export function loadConfig(): AgentConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      focused: { ...DEFAULT_CONFIG.focused, ...(parsed.focused || {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: AgentConfig) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* localStorage unavailable */
  }
}

interface Props {
  config: AgentConfig;
  onChange: (config: AgentConfig) => void;
  open: boolean;
  onToggle: () => void;
}

export function AgentConfigPanel({ config, onChange, open, onToggle }: Props) {
  const update = (patch: Partial<AgentConfig>) => onChange({ ...config, ...patch });
  const toggleAgent = (key: AgentKey) =>
    update({ focused: { ...config.focused, [key]: !config.focused[key] } });

  const focusedCount = Object.values(config.focused).filter(Boolean).length;

  return (
    <Card className="shrink-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-4 h-11 hover:bg-background-secondary-hover transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-button-default-focus-ring"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-body-semibold text-text-primary">Agent configuration</span>
          <Badge variant="muted" className="tabular">
            {focusedCount} of {Object.keys(AGENT_LABELS).length} agents
          </Badge>
          <Badge variant="muted" className="tabular">{config.streamingSpeedMs}ms per agent</Badge>
        </div>
        <span className="inline-flex items-center gap-1 text-caption-1-medium text-text-tertiary shrink-0">
          {open ? "Hide" : "Show"}
          {open ? <RiArrowDownSLine size={16} aria-hidden /> : <RiArrowRightSLine size={16} aria-hidden />}
        </span>
      </button>

      {open && (
        <CardContent className="border-t border-separator-border flex flex-col gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-caption-1-medium text-text-tertiary">Default ticker</span>
              <Input
                value={config.defaultSymbol}
                onChange={(e) =>
                  update({ defaultSymbol: e.target.value.toUpperCase() })
                }
                className="w-32 tabular"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption-1-medium text-text-tertiary">Streaming speed (ms per agent)</span>
              <Input
                type="number"
                min={50}
                max={2000}
                step={50}
                value={config.streamingSpeedMs}
                onChange={(e) =>
                  update({ streamingSpeedMs: Number(e.target.value) || 350 })
                }
                className="w-32 tabular"
              />
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-caption-1-medium text-text-tertiary">Focused agents</span>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(AGENT_LABELS) as AgentKey[]).map((key) => {
                const on = config.focused[key];
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleAgent(key)}
                    className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-border-button-default-focus-ring"
                  >
                    <Badge variant={on ? "accent" : "muted"} className="h-6 px-2 cursor-pointer">
                      {AGENT_LABELS[key]}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap gap-4 text-body-2-regular">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.autoExpandSections}
                onChange={(e) => update({ autoExpandSections: e.target.checked })}
                className="size-3.5 accent-accent-500"
              />
              <span className="text-text-secondary">Auto-expand all sections</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.showAgentChips}
                onChange={(e) => update({ showAgentChips: e.target.checked })}
                className="size-3.5 accent-accent-500"
              />
              <span className="text-text-secondary">Show agent status</span>
            </label>
          </div>

          <div className="pt-3 border-t border-separator-border">
            <Button variant="secondary" size="sm" onClick={() => onChange(DEFAULT_CONFIG)}>
              <RiArrowGoBackLine /> Reset to defaults
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
