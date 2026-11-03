"use client";

import { useEffect, useState } from "react";
import { api, type NewsAnalystRead } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RiLoader4Line as Loader2, RiRefreshLine as RefreshCw } from "@remixicon/react";

const VERDICT_STYLE: Record<string, string> = {
  bullish: "text-status-lime-text bg-status-lime-background border-status-lime-text",
  bearish: "text-status-rose-text bg-status-rose-background border-status-rose-text",
  mixed: "text-status-orange-text-400 bg-status-orange-background-400/10 border-amber-400/30",
  neutral: "text-text-secondary bg-background-secondary-default border-separator-border",
};

/** Compact AI news read for one symbol, verdict chip, bias bar, for/against. */
export function NewsAnalystCard({ symbol }: { symbol: string }) {
  const [read, setRead] = useState<NewsAnalystRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (sym: string) => {
    setLoading(true);
    setError(null);
    api
      .newsAnalyst(sym)
      .then(setRead)
      .catch((e) => {
        setRead(null);
        setError(e instanceof Error ? e.message : "failed");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(symbol);
  }, [symbol]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI news read</CardTitle>
        <div className="ml-auto flex items-center gap-1.5">
          {read && <span className="text-caption-2-regular text-text-tertiary truncate max-w-28">{read.model.split("/").pop()}</span>}
          <button
            onClick={() => load(symbol)}
            disabled={loading}
            className="text-text-tertiary hover:text-text-secondary transition-colors"
            title="refresh"
          >
            <RefreshCw size={10} className={cn(loading && "animate-spin")} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {loading && !read && (
          <div className="flex items-center gap-2 text-caption-1-regular text-text-tertiary py-2">
            <Loader2 size={12} className="animate-spin" /> reading headlines…
          </div>
        )}
        {error && !loading && (
          <p className="text-caption-2-regular text-status-rose-text">{error.includes("503") ? "OPENROUTER_API_KEY not configured" : error}</p>
        )}
        {read && (
          <>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "h-5 px-2 rounded border text-caption-2-regular flex items-center",
                  VERDICT_STYLE[read.verdict] ?? VERDICT_STYLE.neutral
                )}
              >
                {read.verdict}
              </span>
              <span className="text-caption-2-regular tabular text-text-tertiary">{read.confidence}% conf</span>
              {read.cached && <Badge variant="muted">Cached</Badge>}
            </div>

            {/* bias bar: -1 .. +1 */}
            <div className="relative h-1.5 rounded bg-background-secondary-default overflow-hidden">
              <div className="absolute inset-y-0 left-1/2 w-px bg-separator-border" />
              <div
                className={cn("absolute inset-y-0 rounded", read.bias_score >= 0 ? "bg-status-lime-background" : "bg-status-rose-background")}
                style={{
                  left: read.bias_score >= 0 ? "50%" : `${50 + read.bias_score * 50}%`,
                  width: `${Math.abs(read.bias_score) * 50}%`,
                }}
              />
            </div>

            <p className="text-caption-1-regular leading-relaxed text-text-secondary">{read.summary}</p>

            {read.working_for.length > 0 && (
              <div>
                <div className="text-caption-2-regular text-status-lime-text/80 mb-0.5">Working for</div>
                {read.working_for.map((x, i) => (
                  <p key={i} className="text-caption-2-regular text-text-tertiary leading-snug pl-2 border-l border-status-lime-text mb-0.5">{x}</p>
                ))}
              </div>
            )}
            {read.working_against.length > 0 && (
              <div>
                <div className="text-caption-2-regular text-status-rose-text/80 mb-0.5">Working against</div>
                {read.working_against.map((x, i) => (
                  <p key={i} className="text-caption-2-regular text-text-tertiary leading-snug pl-2 border-l border-status-rose-text mb-0.5">{x}</p>
                ))}
              </div>
            )}

            {read.headlines.length > 0 && (
              <details className="group">
                <summary className="text-caption-2-regular text-text-tertiary cursor-pointer hover:text-text-secondary list-none">
                  {read.headlines.length} headlines ▸
                </summary>
                <div className="mt-1 flex flex-col gap-1 max-h-40 overflow-y-auto">
                  {read.headlines.map((h, i) => (
                    <a
                      key={i}
                      href={h.link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-caption-2-regular leading-snug text-text-tertiary hover:text-accent-500 transition-colors"
                    >
                      {h.title}
                    </a>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
