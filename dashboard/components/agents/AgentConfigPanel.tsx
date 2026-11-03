"use client";

import { RiEqualizerLine as Settings2, RiArrowGoBackLine as RotateCcw } from "@remixicon/react";
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
    <section className="rounded-lg border border-separator-border bg-background-primary-default overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-background-secondary-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <Settings2 size={14} className="text-text-secondary" />
          <div className="text-left">
            <div className="text-body-2-regular font-medium text-text-secondary">
              Agent configuration
            </div>
            <div className="text-caption-1-regular text-text-tertiary">
              {focusedCount} of {Object.keys(AGENT_LABELS).length} agents focused · speed{" "}
              {config.streamingSpeedMs}ms
            </div>
          </div>
        </div>
        <span className="text-caption-1-regular text-text-tertiary">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-separator-border space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-caption-2-regular text-text-tertiary">
                Default ticker
              </span>
              <Input
                value={config.defaultSymbol}
                onChange={(e) =>
                  update({ defaultSymbol: e.target.value.toUpperCase() })
                }
                className="h-7 w-24 tabular"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-caption-2-regular text-text-tertiary">
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
            <span className="text-caption-2-regular text-text-tertiary">
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
                      "px-2 py-1 rounded border text-caption-1-regular transition-colors",
                      on
                        ? "border-accent-500 bg-status-blue-background text-accent-500"
                        : "border-separator-border bg-background-secondary-default text-text-tertiary hover:text-text-secondary"
                    )}
                  >
                    {AGENT_LABELS[key]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap gap-4 text-caption-1-regular">
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

          <div className="pt-2 border-t border-separator-border">
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
