"use client";

import { Settings2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
  final_trade_decision: "PM Decision",
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
    <section className="rounded-lg border border-border bg-surface overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-2/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Settings2 size={14} className="text-text-secondary" />
          <div className="text-left">
            <div className="text-sm font-medium text-text-secondary">
              Agent configuration
            </div>
            <div className="text-[11px] text-text-muted">
              {focusedCount} of {Object.keys(AGENT_LABELS).length} agents focused · speed{" "}
              {config.streamingSpeedMs}ms
            </div>
          </div>
        </div>
        <span className="text-[11px] text-text-muted">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-border space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted uppercase tracking-wider">
                Default ticker
              </span>
              <Input
                value={config.defaultSymbol}
                onChange={(e) =>
                  update({ defaultSymbol: e.target.value.toUpperCase() })
                }
                className="h-7 w-24 uppercase tabular"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted uppercase tracking-wider">
                Streaming speed (ms per agent)
              </span>
              <Input
                type="number"
                min={50}
                max={2000}
                step={50}
                value={config.streamingSpeedMs}
                onChange={(e) =>
                  update({ streamingSpeedMs: Number(e.target.value) || 350 })
                }
                className="h-7 w-28 tabular"
              />
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[10px] text-text-muted uppercase tracking-wider">
              Focused agents
            </span>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(AGENT_LABELS) as AgentKey[]).map((key) => {
                const on = config.focused[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleAgent(key)}
                    className={cn(
                      "px-2 py-1 rounded border text-[11px] transition-colors",
                      on
                        ? "border-accent/40 bg-accent/10 text-accent"
                        : "border-border bg-surface-2 text-text-muted hover:text-text-secondary"
                    )}
                  >
                    {AGENT_LABELS[key]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap gap-4 text-[11px]">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.autoExpandSections}
                onChange={(e) => update({ autoExpandSections: e.target.checked })}
                className="h-3.5 w-3.5 accent-accent"
              />
              <span className="text-text-secondary">Auto-expand all sections</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.showAgentChips}
                onChange={(e) => update({ showAgentChips: e.target.checked })}
                className="h-3.5 w-3.5 accent-accent"
              />
              <span className="text-text-secondary">Show agent status chips</span>
            </label>
          </div>

          <div className="pt-2 border-t border-border/50">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange(DEFAULT_CONFIG)}
            >
              <RotateCcw size={12} /> Reset to defaults
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
