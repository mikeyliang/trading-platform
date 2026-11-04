"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { resolveApiBase } from "@/lib/api-base";
import { cn } from "@/lib/utils";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RiCloseLine,
  RiSendPlaneFill,
  RiChat3Line,
  RiStopFill,
  RiFileCopyLine,
  RiCheckLine,
  RiEraserLine,
  RiMagicLine,
  RiArrowRightSLine,
} from "@remixicon/react";
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

// API origin resolved at call time (env override → Coder port-swap →
// same-origin). See lib/api-base.ts.

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
    return () => window.removeEventListener("copilot:prefill", onPrefill as EventListener);
  }, []);

  useEffect(() => {
    if (open && !status) {
      fetch(`${resolveApiBase()}/api/chat/status`)
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
    setMessages((m) => [...m, userMsg, { role: "assistant", content: "", pending: true }]);
    setInput("");
    setStreaming(true);

    const context = buildContext(path, positions, watchlist, lastBacktest);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const resp = await fetch(`${resolveApiBase()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMsg].map(({ role, content }) => ({ role, content })),
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-label="AI co-pilot"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className={cn(
            "fixed right-3 top-3 bottom-3 z-50 w-[calc(100%-24px)] max-w-md flex flex-col overflow-hidden outline-none",
            "rounded-3xl border border-separator-border-button-default bg-background-primary-default shadow-dropdown",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-8",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-8 duration-200"
          )}
        >
          {/* header */}
          <div className="flex items-center gap-2 px-4 h-11 border-b border-separator-border shrink-0">
            <RiChat3Line size={18} className="text-foreground-icon-secondary shrink-0" aria-hidden />
            <DialogTitle className="text-body-semibold text-text-primary">Co-pilot</DialogTitle>
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full shrink-0",
                status?.available ? "bg-status-lime-text" : "bg-foreground-icon-quaternary"
              )}
            />
            <DialogDescription className="text-caption-1-regular tabular text-text-tertiary truncate">
              {status ? (status.available ? status.model?.replace("claude-", "") : "Offline") : "Connecting"}
            </DialogDescription>
            <div className="ml-auto flex items-center gap-0.5">
              {messages.length > 0 && (
                <Button variant="ghost" size="icon-sm" onClick={clear} aria-label="Clear chat">
                  <RiEraserLine />
                </Button>
              )}
              <DialogClose asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close">
                  <RiCloseLine />
                </Button>
              </DialogClose>
            </div>
          </div>

          {/* messages */}
          <div ref={listRef} className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            {messages.length === 0 && (
              <EmptyChat available={!!status?.available} onPick={setInput} />
            )}
            {messages.map((m, i) => (
              <Message key={i} message={m} />
            ))}
          </div>

          {/* composer */}
          <div className="border-t border-separator-border p-3 shrink-0 flex flex-col gap-2">
            <div className="flex items-end gap-2">
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
                aria-label="Message"
                placeholder={
                  status?.available
                    ? "Ask about strategies, backtests or params. Enter sends, Shift+Enter adds a line."
                    : "Set ANTHROPIC_API_KEY in .env to enable chat"
                }
                disabled={!status?.available || streaming}
                rows={2}
                className={cn(
                  "flex-1 min-w-0 resize-none rounded-2lg bg-background-tertiary-default px-2.5 py-1.5 text-body-2-regular text-text-primary",
                  "placeholder:text-text-tertiary outline-none ring-2 ring-inset ring-transparent transition-[background-color,box-shadow] duration-150",
                  "hover:bg-background-tertiary-hover focus:bg-background-primary-default focus:ring-border-button-default-focus-ring",
                  "disabled:cursor-not-allowed disabled:text-input-disabled-text disabled:bg-background-primary-disabled"
                )}
              />
              <Button
                variant={streaming ? "destructive" : "default"}
                size="icon"
                onClick={streaming ? stop : send}
                disabled={!status?.available || (!streaming && !input.trim())}
                aria-label={streaming ? "Stop" : "Send"}
              >
                {streaming ? <RiStopFill /> : <RiSendPlaneFill />}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3 text-caption-1-regular text-text-tertiary">
              <span className="truncate">Context: {summarizeContext(path, positions.length, watchlist.length)}</span>
              <kbd className="inline-flex items-center h-5 px-1.5 rounded-md bg-kbd-background text-kbd-foreground text-caption-1-medium tabular shrink-0">
                ⌘J
              </kbd>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
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
    <div className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
      <div className="text-caption-1-medium text-text-tertiary">
        {isUser ? "You" : "Co-pilot"}
      </div>

      {/* main bubble */}
      <div
        className={cn(
          "group relative max-w-[92%] rounded-2lg px-3 py-2 text-body-2-regular",
          isUser
            ? "bg-status-blue-background text-text-primary"
            : "bg-background-secondary-default text-text-secondary"
        )}
      >
        {message.pending && !message.content ? (
          <div className="flex flex-col gap-1.5 py-0.5 min-w-[120px]" role="status" aria-label="Thinking">
            <Skeleton className="h-2.5 w-3/4" />
            <Skeleton className="h-2.5 w-1/2" />
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
              ) : null
            )}
          </div>
        )}
        {!message.pending && message.content && (
          <button
            type="button"
            onClick={copy}
            className="absolute -top-2.5 -right-2.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 size-6 rounded-md bg-background-primary-default border border-separator-border-button-default shadow-xs flex items-center justify-center text-foreground-icon-tertiary hover:text-text-primary transition-colors outline-none"
            aria-label={copied ? "Copied" : "Copy"}
          >
            {copied ? <RiCheckLine size={14} aria-hidden /> : <RiFileCopyLine size={14} aria-hidden />}
          </button>
        )}
      </div>

      {/* preview cards rendered below the text bubble */}
      {segments
        ?.filter((s): s is { type: "proposal"; data: ParamProposal } => s.type === "proposal")
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

type Segment = { type: "text"; text: string } | { type: "proposal"; data: ParamProposal };

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
    // if not closed yet (still streaming), skip, wait for next render
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
    <div className="max-w-[92%] w-full rounded-2lg bg-background-secondary-default p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <RiMagicLine size={16} className="text-accent-600 shrink-0" aria-hidden />
        <span className="text-caption-1-medium text-text-primary">Suggested params</span>
        <span className="text-caption-1-regular tabular text-text-tertiary ml-auto truncate">
          {proposal.strategy}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-caption-1-regular">
        {paramEntries.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-2">
            <span className="text-text-tertiary tabular truncate">{k}</span>
            <span className="tabular text-text-primary text-caption-1-medium">{String(v)}</span>
          </div>
        ))}
      </div>

      {proposal.rationale && (
        <p className="text-caption-1-regular text-text-secondary border-t border-separator-border pt-2">
          {proposal.rationale}
        </p>
      )}

      <Button
        variant={applied ? "secondary" : "default"}
        onClick={apply}
        disabled={applied}
        className="self-stretch"
      >
        {applied ? (
          <>
            <RiCheckLine />
            Applied, open Simulate
          </>
        ) : (
          <>
            Apply and open Simulate
            <RiArrowRightSLine />
          </>
        )}
      </Button>
    </div>
  );
}

function EmptyChat({ available, onPick }: { available: boolean; onPick: (s: string) => void }) {
  if (!available) {
    return (
      <EmptyState
        icon={RiChat3Line}
        title="Chat is disabled"
        description="Add ANTHROPIC_API_KEY to .env and restart the api container."
      />
    );
  }

  const suggestions = [
    "Explain my last backtest result",
    "What params should I tune to improve Sharpe?",
    "Compare smi-short vs smi-mid for SPY",
    "Why is win rate low when SMI signals fire fast?",
  ];

  return (
    <div className="flex flex-col gap-3 py-4">
      <EmptyState
        icon={RiChat3Line}
        title="Ask the co-pilot"
        description="Strategies, params or the last backtest. It sees your current page, positions and watchlist."
        className="py-4"
      />
      <div className="flex flex-col gap-1.5">
        {suggestions.map((s) => (
          <Button key={s} variant="secondary" onClick={() => onPick(s)} className="justify-start text-text-secondary hover:text-text-primary">
            {s}
          </Button>
        ))}
      </div>
    </div>
  );
}

function buildContext(
  path: string | null,
  positions: any[],
  watchlist: any[],
  lastBacktest: any | null
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

function summarizeContext(path: string | null, posCount: number, watchCount: number): string {
  const parts: string[] = [];
  if (path) parts.push(`page ${path}`);
  if (posCount) parts.push(`${posCount} positions`);
  if (watchCount) parts.push(`${watchCount} symbols`);
  return parts.join(", ") || "minimal";
}
