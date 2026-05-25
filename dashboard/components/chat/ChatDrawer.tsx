"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  X,
  Send,
  Sparkles,
  Loader2,
  Copy,
  Check,
  Eraser,
  Wand2,
  ChevronRight,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "@/components/ui/toaster";
import { useChatAvailable } from "@/lib/chat-availability";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
}

interface ChatStatus {
  available: boolean;
  model: string;
}

const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export function ChatDrawer() {
  const available = useChatAvailable();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const path = usePathname();
  const positions = useStore((s) => s.positions);
  const watchlist = useStore((s) => s.watchlist);
  const lastBacktest = useStore((s) => s.lastBacktest);
  const setPendingSuggestion = useStore((s) => s.setPendingSuggestion);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cmd/Ctrl+J to toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "j" || e.key === "J") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape" && open) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // External components can prefill the composer (e.g. analyzer "Ask AI")
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const ce = e as CustomEvent<{ prompt: string }>;
      if (!ce.detail?.prompt) return;
      setOpen(true);
      setInput(ce.detail.prompt);
      setTimeout(() => inputRef.current?.focus(), 150);
    };
    window.addEventListener("copilot:prefill", onPrefill as EventListener);
    return () =>
      window.removeEventListener("copilot:prefill", onPrefill as EventListener);
  }, []);

  useEffect(() => {
    if (open && !status) {
      fetch(`${BASE}/api/chat/status`)
        .then((r) => r.json())
        .then(setStatus)
        .catch(() => setStatus({ available: false, model: "unknown" }));
    }
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, status]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async () => {
    if (!input.trim() || streaming) return;
    const userMsg: ChatMessage = { role: "user", content: input.trim() };
    setMessages((m) => [
      ...m,
      userMsg,
      { role: "assistant", content: "", pending: true },
    ]);
    setInput("");
    setStreaming(true);

    const context = buildContext(path, positions, watchlist, lastBacktest);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const resp = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMsg].map(({ role, content }) => ({
            role,
            content,
          })),
          context,
          effort: "high",
        }),
        signal: ac.signal,
      });

      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => "");
        throw new Error(text || `chat failed: ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const chunk of events) {
          const line = chunk.replace(/^data: /, "").trim();
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "delta") {
              setMessages((m) => {
                const next = [...m];
                const last = next[next.length - 1];
                if (last && last.role === "assistant") {
                  next[next.length - 1] = {
                    ...last,
                    content: last.content + event.text,
                    pending: false,
                  };
                }
                return next;
              });
            } else if (event.type === "error") {
              throw new Error(event.message);
            }
          } catch (e) {
            console.warn("bad SSE event", line, e);
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof Error ? e.message : "chat failed";
      toast.error("Chat error", { description: msg });
      setMessages((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last && last.role === "assistant" && !last.content) {
          next.pop(); // remove the empty placeholder
        }
        return next;
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const clear = () => {
    setMessages([]);
    inputRef.current?.focus();
  };

  // Globally disable the drawer when no API key is configured.
  if (available === false) return null;

  return (
    <>
      {/* backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity",
          open
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none",
        )}
        onClick={() => setOpen(false)}
        aria-hidden
      />

      {/* drawer */}
      <aside
        role="dialog"
        aria-label="AI chat"
        className={cn(
          "fixed top-0 right-0 z-50 h-full w-full max-w-md bg-surface border-l border-border shadow-2xl flex flex-col transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* header */}
        <div className="flex items-center gap-2 px-4 h-10 border-b border-border/60 shrink-0">
          <Sparkles size={12} className="text-accent" />
          <span className="text-xs font-medium text-text-primary">
            Co-pilot
          </span>
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full",
              status?.available ? "bg-up" : "bg-text-muted",
            )}
          />
          <span className="text-[10px] tabular text-text-muted">
            {status?.model?.replace("claude-", "") ?? "—"}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            {messages.length > 0 && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={clear}
                aria-label="Clear chat"
              >
                <Eraser />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              <X />
            </Button>
          </div>
        </div>

        {/* messages */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto p-4 flex flex-col gap-4"
        >
          {messages.length === 0 && (
            <EmptyChat available={!!status?.available} onPick={setInput} />
          )}
          {messages.map((m, i) => (
            <Message key={i} message={m} />
          ))}
        </div>

        {/* composer */}
        <div className="border-t border-border p-3 shrink-0">
          <div className="relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                status?.available
                  ? "Ask about strategies, backtests, params… (Enter to send, ⇧Enter for newline)"
                  : "Set ANTHROPIC_API_KEY in .env to enable chat"
              }
              disabled={!status?.available || streaming}
              rows={2}
              className="w-full resize-none bg-surface-2 border border-border rounded-md px-3 py-2 pr-10 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-accent disabled:opacity-50"
            />
            <button
              onClick={streaming ? stop : send}
              disabled={!status?.available || (!streaming && !input.trim())}
              className={cn(
                "absolute right-2 bottom-2 w-7 h-7 flex items-center justify-center rounded transition-colors",
                streaming
                  ? "bg-down/15 text-down hover:bg-down/25"
                  : "bg-accent text-white hover:bg-accent/90 disabled:opacity-40 disabled:hover:bg-accent",
              )}
              aria-label={streaming ? "Stop" : "Send"}
            >
              {streaming ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Send size={12} />
              )}
            </button>
          </div>
          <div className="flex items-center justify-between mt-1.5 text-[10px] text-text-muted">
            <span>
              Context:{" "}
              {summarizeContext(path, positions.length, watchlist.length)}
            </span>
            <kbd className="font-mono">⌘J</kbd>
          </div>
        </div>
      </aside>
    </>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";

  const copy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  // For assistant messages, split into text and structured proposal blocks
  const segments = isUser ? null : parseAssistantContent(message.content);

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5",
        isUser ? "items-end" : "items-start",
      )}
    >
      <div className="text-[10px] uppercase tracking-wider text-text-muted">
        {isUser ? "you" : "co-pilot"}
      </div>

      {/* main bubble */}
      <div
        className={cn(
          "group relative max-w-[92%] rounded-md px-3 py-2 text-xs leading-relaxed",
          isUser
            ? "bg-accent/15 border border-accent/30 text-text-primary"
            : "bg-surface-2 border border-border text-text-secondary",
        )}
      >
        {message.pending && !message.content ? (
          <div className="flex flex-col gap-1.5 py-0.5 min-w-[120px]">
            <Skeleton className="h-2 w-3/4" />
            <Skeleton className="h-2 w-1/2" />
          </div>
        ) : isUser ? (
          <span className="whitespace-pre-wrap">{message.content}</span>
        ) : (
          <div className="prose-chat">
            {segments?.map((seg, i) =>
              seg.type === "text" ? (
                <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
                  {seg.text}
                </ReactMarkdown>
              ) : null,
            )}
          </div>
        )}
        {!message.pending && message.content && (
          <button
            onClick={copy}
            className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 w-5 h-5 rounded bg-surface border border-border flex items-center justify-center text-text-muted hover:text-text-primary transition-all"
            aria-label="Copy"
          >
            {copied ? <Check size={9} /> : <Copy size={9} />}
          </button>
        )}
      </div>

      {/* preview cards rendered below the text bubble */}
      {segments
        ?.filter(
          (s): s is { type: "proposal"; data: ParamProposal } =>
            s.type === "proposal",
        )
        .map((seg, i) => (
          <ProposalCard key={`p${i}`} proposal={seg.data} />
        ))}
    </div>
  );
}

interface ParamProposal {
  strategy: string;
  params: Record<string, unknown>;
  rationale?: string;
}

type Segment =
  | { type: "text"; text: string }
  | { type: "proposal"; data: ParamProposal };

function parseAssistantContent(content: string): Segment[] {
  if (!content) return [];
  const segments: Segment[] = [];
  // Match ```params ... ``` or ```params\n...\n``` blocks, even mid-stream
  const re = /```params\s*\n([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ type: "text", text: before });
    const raw = match[1].trim();
    const closed = match[0].endsWith("```");
    if (closed) {
      try {
        const data = JSON.parse(raw) as ParamProposal;
        if (data && typeof data === "object" && data.params) {
          segments.push({ type: "proposal", data });
        }
      } catch {
        // partial / malformed → render as text inline so user sees raw
        segments.push({ type: "text", text: "```params\n" + raw + "\n```" });
      }
    }
    // if not closed yet (still streaming), skip — wait for next render
    lastIndex = match.index + match[0].length;
  }
  const tail = content.slice(lastIndex);
  if (tail.trim()) segments.push({ type: "text", text: tail });
  return segments.length ? segments : [{ type: "text", text: content }];
}

function ProposalCard({ proposal }: { proposal: ParamProposal }) {
  const setPendingSuggestion = useStore((s) => s.setPendingSuggestion);
  const [applied, setApplied] = useState(false);

  const apply = () => {
    // Stores the proposal in the global suggestion slot. The dedicated
    // /backtest page has been removed; surfacing the suggestion is now
    // the strategy panels' job whenever they next render.
    setPendingSuggestion({
      id: `s-${Date.now()}`,
      strategy: proposal.strategy,
      params: proposal.params,
      rationale: proposal.rationale,
      source: "agent",
      timestamp: Date.now(),
    });
    setApplied(true);
  };

  const paramEntries = Object.entries(proposal.params);

  return (
    <div className="max-w-[92%] w-full rounded-md border border-accent/30 bg-accent/5 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Wand2 size={11} className="text-accent" />
        <span className="text-[10px] uppercase tracking-wider text-accent font-medium">
          Suggested params
        </span>
        <span className="text-[10px] tabular text-text-muted ml-auto">
          {proposal.strategy}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        {paramEntries.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between">
            <span className="text-text-muted font-mono text-[10px]">{k}</span>
            <span className="tabular text-text-primary">{String(v)}</span>
          </div>
        ))}
      </div>

      {proposal.rationale && (
        <p className="text-[11px] text-text-secondary leading-relaxed border-t border-border/60 pt-2">
          {proposal.rationale}
        </p>
      )}

      <Button
        size="sm"
        variant={applied ? "secondary" : "default"}
        onClick={apply}
        disabled={applied}
        className="self-stretch"
      >
        {applied ? (
          <>
            <Check />
            Applied — open Backtest
          </>
        ) : (
          <>
            Apply &amp; open Backtest
            <ChevronRight />
          </>
        )}
      </Button>
    </div>
  );
}

function EmptyChat({
  available,
  onPick,
}: {
  available: boolean;
  onPick: (s: string) => void;
}) {
  if (!available) {
    return (
      <div className="text-center text-[11px] text-text-muted py-12">
        <Sparkles size={20} className="mx-auto mb-2 text-text-muted/60" />
        <p className="mb-1 text-text-secondary font-medium">Chat is disabled</p>
        <p>
          Add{" "}
          <code className="text-[10px] bg-surface-2 px-1 py-0.5 rounded">
            ANTHROPIC_API_KEY
          </code>{" "}
          to{" "}
          <code className="text-[10px] bg-surface-2 px-1 py-0.5 rounded">
            .env
          </code>{" "}
          and restart the api container.
        </p>
      </div>
    );
  }

  const suggestions = [
    "Explain my last backtest result",
    "What params should I tune to improve Sharpe?",
    "Compare smi-short vs smi-mid for SPY",
    "Why is win rate low when SMI signals fire fast?",
  ];

  return (
    <div className="flex flex-col gap-3 py-6">
      <div className="text-center mb-2">
        <Sparkles size={20} className="mx-auto mb-2 text-accent" />
        <p className="text-xs text-text-secondary">
          Ask about strategies, params, or last backtest.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="text-left text-[11px] px-3 py-2 rounded-md border border-border bg-surface-2 hover:bg-surface-3 hover:border-surface-3 text-text-secondary hover:text-text-primary transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function buildContext(
  path: string | null,
  positions: any[],
  watchlist: any[],
  lastBacktest: any | null,
): Record<string, unknown> {
  return {
    current_page: path ?? "/",
    open_positions: positions.slice(0, 20).map((p: any) => ({
      symbol: p.symbol,
      qty: p.quantity,
      avg: p.avg_price,
      unrealized_pnl: p.unrealized_pnl,
    })),
    watchlist_symbols: watchlist.slice(0, 30).map((w: any) => w.symbol),
    last_backtest: lastBacktest
      ? {
          id: lastBacktest.id,
          strategy: lastBacktest.strategy,
          symbol: lastBacktest.symbol,
          timeframe: lastBacktest.timeframe,
          dates: `${lastBacktest.start_date} → ${lastBacktest.end_date}`,
          return_pct: lastBacktest.total_return_pct,
          sharpe: lastBacktest.sharpe_ratio,
          win_rate: lastBacktest.win_rate,
          total_trades: lastBacktest.total_trades,
          max_drawdown_pct: lastBacktest.max_drawdown_pct,
          profit_factor: lastBacktest.profit_factor,
        }
      : null,
  };
}

function summarizeContext(
  path: string | null,
  posCount: number,
  watchCount: number,
): string {
  const parts: string[] = [];
  if (path) parts.push(`page ${path}`);
  if (posCount) parts.push(`${posCount} pos`);
  if (watchCount) parts.push(`${watchCount} sym`);
  return parts.join(" · ") || "minimal";
}
