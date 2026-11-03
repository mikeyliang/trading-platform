"use client";

import { useEffect, useState } from "react";
import { api, type NewsAnalystRead } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RiArrowRightSLine, RiErrorWarningFill, RiRefreshLine } from "@remixicon/react";

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

const VERDICT_VARIANT: Record<string, BadgeVariant> = {
  bullish: "up",
  bearish: "down",
  mixed: "warning",
  neutral: "muted",
};

const VERDICT_LABEL: Record<string, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  mixed: "Mixed",
  neutral: "Neutral",
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
        <div className="flex items-center gap-2">
          {read && (
            <span className="text-caption-1-regular text-text-tertiary truncate max-w-28">
              {read.model.split("/").pop()}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => load(symbol)}
            disabled={loading}
            aria-label="Refresh news read"
          >
            <RiRefreshLine className={cn(loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading && !read && (
          <div className="flex flex-col gap-2 py-1" role="status" aria-label="Reading headlines">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-1.5 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        )}
        {error && !loading && (
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="down" className="gap-1">
              <RiErrorWarningFill size={14} aria-hidden />
              {error.includes("503") ? "No OpenRouter key configured" : "Read failed"}
            </Badge>
            <Button variant="secondary" size="sm" onClick={() => load(symbol)}>Retry</Button>
          </div>
        )}
        {read && (
          <>
            <div className="flex items-center gap-2">
              <Badge variant={VERDICT_VARIANT[read.verdict] ?? "muted"}>
                {VERDICT_LABEL[read.verdict] ?? read.verdict}
              </Badge>
              <span className="text-caption-1-regular tabular text-text-tertiary">{read.confidence}% confidence</span>
              {read.cached && <Badge variant="muted">Cached</Badge>}
            </div>

            {/* bias bar: -1 .. +1 */}
            <div className="relative h-1.5 rounded-full bg-background-tertiary-default overflow-hidden" aria-hidden>
              <div className="absolute inset-y-0 left-1/2 w-px bg-separator-border-strong" />
              <div
                className={cn("absolute inset-y-0 rounded-full", read.bias_score >= 0 ? "bg-status-lime-text" : "bg-status-rose-text")}
                style={{
                  left: read.bias_score >= 0 ? "50%" : `${50 + read.bias_score * 50}%`,
                  width: `${Math.abs(read.bias_score) * 50}%`,
                }}
              />
            </div>

            <p className="text-body-2-regular text-text-secondary">{read.summary}</p>

            {read.working_for.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-caption-1-medium text-status-lime-text">Working for</div>
                {read.working_for.map((x, i) => (
                  <p key={i} className="text-caption-1-regular text-text-secondary pl-2 border-l-2 border-status-lime-text">{x}</p>
                ))}
              </div>
            )}
            {read.working_against.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-caption-1-medium text-status-rose-text">Working against</div>
                {read.working_against.map((x, i) => (
                  <p key={i} className="text-caption-1-regular text-text-secondary pl-2 border-l-2 border-status-rose-text">{x}</p>
                ))}
              </div>
            )}

            {read.headlines.length > 0 && (
              <details className="group">
                <summary className="inline-flex items-center gap-1 text-caption-1-medium text-text-tertiary cursor-pointer hover:text-text-primary list-none select-none">
                  <RiArrowRightSLine size={14} className="transition-transform group-open:rotate-90" aria-hidden />
                  {read.headlines.length} headlines
                </summary>
                <div className="mt-2 flex flex-col gap-1.5 max-h-40 overflow-y-auto">
                  {read.headlines.map((h, i) => (
                    <a
                      key={i}
                      href={h.link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-caption-1-regular text-text-secondary hover:text-accent-600 transition-colors"
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
