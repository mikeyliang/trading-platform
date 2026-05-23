"use client";

import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  allTags,
  newEntry,
  useJournal,
  type JournalEntry,
  type Mood,
} from "@/lib/journal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { toast } from "@/components/ui/toaster";
import {
  Plus,
  Trash2,
  BookOpen,
  Eye,
  Edit3,
  Save,
  X as XIcon,
  Search,
  Tag,
} from "lucide-react";
import { cn } from "@/lib/utils";

const MOODS: Mood[] = ["🚀", "👍", "😐", "👎", "💀"];

export default function JournalPage() {
  const { entries, hydrated, upsert, remove } = useJournal();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showAllTags, setShowAllTags] = useState(false);

  const tags = useMemo(() => allTags(entries), [entries]);
  const TAG_CAP = 6;
  const visibleTags = showAllTags ? tags : tags.slice(0, TAG_CAP);
  const overflowTagCount = Math.max(0, tags.length - TAG_CAP);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries.filter((e) => {
      if (tagFilter && !e.tags.includes(tagFilter)) return false;
      if (!q) return true;
      const hay = `${e.title} ${e.body} ${e.tags.join(" ")} ${e.symbol ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [entries, filter, tagFilter]);

  const active = activeId ? entries.find((e) => e.id === activeId) ?? null : null;

  const create = () => {
    const e = newEntry();
    upsert(e);
    setActiveId(e.id);
    setEditing(true);
  };

  const onSaved = (e: JournalEntry) => {
    upsert(e);
    setEditing(false);
    toast.success("Entry saved");
  };

  const onDelete = (e: JournalEntry) => {
    remove(e.id);
    if (activeId === e.id) {
      setActiveId(null);
      setEditing(false);
    }
    toast("Entry removed");
  };

  return (
    <PageShell className="!overflow-hidden">
      <PageHeader
        title="Journal"
        actions={
          <>
            <Badge variant="muted">{entries.length}</Badge>
            <Button variant="default" size="sm" onClick={create}>
              <Plus />
              New
            </Button>
          </>
        }
      />

      {hydrated && entries.length === 0 ? (
        <Card className="flex-1 flex items-center justify-center min-h-40">
          <EmptyState
            icon={BookOpen}
            title="No journal entries yet"
            description="Start logging thoughts on setups, post-trade reviews, or daily reflections."
            action={
              <Button variant="default" size="sm" onClick={create}>
                <Plus />
                Write first entry
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-[280px_1fr] gap-3 flex-1 min-h-0">
          {/* left rail: filter + list */}
          <Card className="flex flex-col min-h-0 overflow-hidden">
            <div className="p-2 border-b border-border/60 shrink-0 flex flex-col gap-2">
              <div className="relative">
                <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search entries…"
                  className="pl-7 h-7 text-[11px]"
                />
              </div>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {visibleTags.map((t) => (
                    <button
                      key={t}
                      onClick={() => setTagFilter(tagFilter === t ? null : t)}
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded border transition-colors",
                        tagFilter === t
                          ? "bg-accent/15 text-accent border-accent/30"
                          : "bg-surface-2 text-text-muted border-border hover:text-text-secondary"
                      )}
                    >
                      #{t}
                    </button>
                  ))}
                  {overflowTagCount > 0 && (
                    <button
                      onClick={() => setShowAllTags((v) => !v)}
                      className="text-[10px] px-1.5 py-0.5 text-text-muted hover:text-text-secondary"
                    >
                      {showAllTags ? "less" : `+${overflowTagCount}`}
                    </button>
                  )}
                  {tagFilter && (
                    <button
                      onClick={() => setTagFilter(null)}
                      className="text-[10px] px-1.5 py-0.5 text-text-muted hover:text-down"
                    >
                      clear
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="text-center py-6 text-[11px] text-text-muted">no matches</div>
              ) : (
                filtered.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => {
                      setActiveId(e.id);
                      setEditing(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-2 border-b border-border/40 hover:bg-surface-2 transition-colors flex flex-col gap-0.5",
                      activeId === e.id && "bg-surface-2"
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {e.mood && <span className="text-xs leading-none shrink-0">{e.mood}</span>}
                      <span className="text-xs font-medium text-text-primary truncate min-w-0">
                        {e.title || "(untitled)"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-text-muted tabular">
                      <span>{e.date}</span>
                      {e.symbol && <span className="text-accent">{e.symbol}</span>}
                      {e.tags.slice(0, 2).map((t) => (
                        <span key={t}>#{t}</span>
                      ))}
                    </div>
                  </button>
                ))
              )}
            </div>
          </Card>

          {/* right pane: editor / viewer */}
          <Card className="flex flex-col min-h-0 overflow-hidden">
            {active ? (
              editing ? (
                <Editor
                  key={active.id}
                  initial={active}
                  onSave={onSaved}
                  onCancel={() => setEditing(false)}
                  onDelete={() => onDelete(active)}
                />
              ) : (
                <Viewer
                  entry={active}
                  onEdit={() => setEditing(true)}
                  onDelete={() => onDelete(active)}
                />
              )
            ) : (
              <div className="flex-1 flex items-center justify-center text-[11px] text-text-muted">
                Select an entry from the left, or create a new one.
              </div>
            )}
          </Card>
        </div>
      )}
    </PageShell>
  );
}

function Viewer({
  entry,
  onEdit,
  onDelete,
}: {
  entry: JournalEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2 px-4 h-10 border-b border-border/60 shrink-0">
        {entry.mood && <span className="text-base leading-none">{entry.mood}</span>}
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary leading-tight truncate">
            {entry.title || "(untitled)"}
          </div>
          <div className="text-[10px] text-text-muted tabular">
            {entry.date}
            {entry.symbol && <> · <span className="text-accent">{entry.symbol}</span></>}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Edit">
                <Edit3 />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Edit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label="Delete">
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {entry.tags.length > 0 && (
        <div className="px-4 py-2 border-b border-border/60 flex flex-wrap gap-1.5 shrink-0">
          {entry.tags.map((t) => (
            <Badge key={t} variant="default" className="text-[9px]">
              #{t}
            </Badge>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3">
        {entry.body.trim() ? (
          <div className="prose-chat">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.body}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-[11px] text-text-muted">No body yet. Click edit to add one.</p>
        )}
      </div>
    </>
  );
}

function Editor({
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: JournalEntry;
  onSave: (e: JournalEntry) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<JournalEntry>(initial);
  const [tagInput, setTagInput] = useState("");

  const update = <K extends keyof JournalEntry>(key: K, value: JournalEntry[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const addTag = () => {
    const v = tagInput.trim().toLowerCase().replace(/^#/, "");
    if (!v) return;
    if (!draft.tags.includes(v)) setDraft((d) => ({ ...d, tags: [...d.tags, v] }));
    setTagInput("");
  };
  const removeTag = (t: string) => setDraft((d) => ({ ...d, tags: d.tags.filter((x) => x !== t) }));

  return (
    <>
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border/60 shrink-0">
        <Input
          value={draft.title}
          onChange={(e) => update("title", e.target.value)}
          placeholder="Title…"
          className="h-7 text-xs font-medium"
        />
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <XIcon />
            Cancel
          </Button>
          <Button variant="default" size="sm" onClick={() => onSave(draft)}>
            <Save />
            Save
          </Button>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-border/60 grid grid-cols-2 md:grid-cols-4 gap-2 shrink-0 text-[11px]">
        <label className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Date</span>
          <Input
            type="date"
            value={draft.date}
            onChange={(e) => update("date", e.target.value)}
            className="h-7 flex-1 text-[11px]"
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Symbol</span>
          <Input
            value={draft.symbol ?? ""}
            onChange={(e) => update("symbol", e.target.value.toUpperCase() || undefined)}
            placeholder="optional"
            className="h-7 flex-1 text-[11px] uppercase tabular"
          />
        </label>
        <label className="flex items-center gap-2 col-span-2">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Mood</span>
          <div className="flex gap-1">
            {MOODS.map((m) => (
              <button
                key={m}
                onClick={() => update("mood", draft.mood === m ? undefined : m)}
                className={cn(
                  "w-6 h-6 rounded text-sm transition-all leading-none",
                  draft.mood === m
                    ? "bg-accent/20 border border-accent/40 scale-110"
                    : "bg-surface-2 border border-border hover:border-surface-3"
                )}
                aria-label={`mood ${m}`}
              >
                {m}
              </button>
            ))}
          </div>
        </label>
      </div>

      <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2 flex-wrap shrink-0">
        <Tag size={11} className="text-text-muted" />
        {draft.tags.map((t) => (
          <button
            key={t}
            onClick={() => removeTag(t)}
            className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/30 hover:bg-down/10 hover:text-down hover:border-down/30"
          >
            #{t} ×
          </button>
        ))}
        <Input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={addTag}
          placeholder="add tag"
          className="h-6 w-28 text-[10px]"
        />
      </div>

      <textarea
        value={draft.body}
        onChange={(e) => update("body", e.target.value)}
        placeholder="What did you see? What was the setup? What went right/wrong? Lessons?…"
        className="flex-1 w-full bg-bg p-3 text-[11px] leading-relaxed text-text-primary placeholder:text-text-muted outline-none resize-none font-mono"
      />

      <div className="flex items-center px-3 h-9 border-t border-border/60 shrink-0 text-[10px] text-text-muted">
        <span>Markdown supported — preview after saving.</span>
        <button
          onClick={onDelete}
          className="ml-auto text-text-muted hover:text-down transition-colors flex items-center gap-1"
        >
          <Trash2 size={10} />
          Delete entry
        </button>
      </div>
    </>
  );
}
