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
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { toast } from "@/components/ui/toaster";
import {
  RiAddLine as Plus,
  RiDeleteBinLine as Trash2,
  RiBookOpenLine as BookOpen,
  RiEditLine as Edit3,
  RiSaveLine as Save,
  RiCloseLine as XIcon,
  RiSearchLine as Search,
  RiPriceTag3Line as Tag,
  RiFileTextLine as EntryIcon,
} from "@remixicon/react";
import { cn } from "@/lib/utils";

const MOODS: Mood[] = ["\u{1F680}", "\u{1F44D}", "\u{1F610}", "\u{1F44E}", "\u{1F480}"];
const MOOD_LABEL: Record<string, string> = {
  "\u{1F680}": "Great",
  "\u{1F44D}": "Good",
  "\u{1F610}": "Flat",
  "\u{1F44E}": "Poor",
  "\u{1F480}": "Blown",
};

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
        description="Setups, post-trade reviews and daily reflections, kept in this browser."
        actions={
          <Button variant="default" onClick={create}>
            <Plus />
            New entry
          </Button>
        }
      />

      {!hydrated ? (
        <Card className="flex-1 min-h-40">
          <CardHeader>
            <CardTitle>Entries</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </CardContent>
        </Card>
      ) : entries.length === 0 ? (
        <Card className="flex-1 flex items-center justify-center min-h-40">
          <EmptyState
            icon={BookOpen}
            title="No journal entries yet"
            description="Start logging thoughts on setups, post-trade reviews, or daily reflections."
            action={
              <Button variant="default" onClick={create}>
                <Plus />
                Write first entry
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-3 flex-1 min-h-0">
          {/* left rail: filter + list */}
          <Card className="flex flex-col min-h-0">
            <CardHeader>
              <div className="flex items-center gap-2 min-w-0">
                <CardTitle>Entries</CardTitle>
                <Badge variant="muted" className="tabular">{entries.length}</Badge>
              </div>
            </CardHeader>
            <div className="p-3 border-b border-separator-border shrink-0 flex flex-col gap-2">
              <div className="relative">
                <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-icon-tertiary" aria-hidden="true" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search entries"
                  className="pl-8"
                  aria-label="Search entries"
                />
              </div>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {visibleTags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTagFilter(tagFilter === t ? null : t)}
                      aria-pressed={tagFilter === t}
                      className={cn(
                        "inline-flex items-center h-5 px-1.5 rounded-md text-caption-1-medium transition-colors",
                        tagFilter === t
                          ? "bg-status-blue-background text-status-blue-text"
                          : "bg-background-secondary-default text-text-tertiary hover:text-text-secondary"
                      )}
                    >
                      #{t}
                    </button>
                  ))}
                  {overflowTagCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowAllTags((v) => !v)}
                      className="inline-flex items-center h-5 px-1.5 text-caption-1-medium text-text-tertiary hover:text-text-secondary"
                    >
                      {showAllTags ? "Less" : `+${overflowTagCount}`}
                    </button>
                  )}
                  {tagFilter && (
                    <button
                      type="button"
                      onClick={() => setTagFilter(null)}
                      className="inline-flex items-center h-5 px-1.5 text-caption-1-medium text-text-tertiary hover:text-status-rose-text"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <EmptyState size="sm" icon={Search} title="No matches" description="Try another search or clear the tag filter." />
              ) : (
                filtered.map((e) => {
                  const selected = activeId === e.id;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => {
                        setActiveId(e.id);
                        setEditing(false);
                      }}
                      aria-current={selected ? "true" : undefined}
                      className={cn(
                        "w-full text-left px-4 py-2.5 border-b border-separator-border transition-colors flex flex-col gap-0.5",
                        selected
                          ? "bg-accent-50 dark:bg-accent-950/40"
                          : "hover:bg-background-secondary-hover"
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-body-2-medium text-text-primary truncate min-w-0">
                          {e.title || "Untitled"}
                        </span>
                        {e.mood && (
                          <span className="ml-auto shrink-0 text-caption-1-medium text-text-tertiary">
                            {MOOD_LABEL[e.mood] ?? e.mood}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-caption-1-medium text-text-tertiary tabular">
                        <span>{e.date}</span>
                        {e.symbol && <span className="text-text-secondary">{e.symbol}</span>}
                        {e.tags.slice(0, 2).map((t) => (
                          <span key={t}>#{t}</span>
                        ))}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </Card>

          {/* right pane: editor / viewer */}
          <Card className="flex flex-col min-h-0">
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
              <div className="flex-1 flex items-center justify-center">
                <EmptyState
                  icon={EntryIcon}
                  title="Pick an entry"
                  description="Select an entry on the left to read it, or start a new one."
                  action={
                    <Button variant="secondary" onClick={create}>
                      <Plus />
                      New entry
                    </Button>
                  }
                />
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
      <CardHeader>
        <div className="min-w-0 flex items-center gap-3">
          <CardTitle>{entry.title || "Untitled"}</CardTitle>
          <span className="flex items-center gap-2 text-caption-1-medium text-text-tertiary tabular shrink-0">
            <span>{entry.date}</span>
            {entry.symbol && <span className="text-text-secondary">{entry.symbol}</span>}
            {entry.mood && <Badge variant="muted">{MOOD_LABEL[entry.mood] ?? entry.mood}</Badge>}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary" size="icon" onClick={onEdit} aria-label="Edit">
                <Edit3 />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Edit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary" size="icon" onClick={onDelete} aria-label="Delete">
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Delete</TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>

      {entry.tags.length > 0 && (
        <div className="px-4 py-2 border-b border-separator-border flex flex-wrap gap-1.5 shrink-0">
          {entry.tags.map((t) => (
            <Badge key={t} variant="default">
              #{t}
            </Badge>
          ))}
        </div>
      )}

      <CardContent className="flex-1 overflow-y-auto">
        {entry.body.trim() ? (
          <div className="prose-chat text-body-2-regular">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.body}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-body-2-regular text-text-tertiary">No body yet. Edit the entry to add one.</p>
        )}
      </CardContent>
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
      <CardHeader>
        <Input
          value={draft.title}
          onChange={(e) => update("title", e.target.value)}
          placeholder="Title"
          aria-label="Title"
          className="max-w-md"
        />
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="secondary" onClick={onCancel}>
            <XIcon />
            Cancel
          </Button>
          <Button variant="default" onClick={() => onSave(draft)}>
            <Save />
            Save
          </Button>
        </div>
      </CardHeader>

      <div className="px-4 py-3 border-b border-separator-border grid grid-cols-2 md:grid-cols-4 gap-3 shrink-0">
        <label className="flex flex-col gap-1">
          <span className="text-caption-1-medium text-text-tertiary">Date</span>
          <Input
            type="date"
            value={draft.date}
            onChange={(e) => update("date", e.target.value)}
            className="tabular"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-caption-1-medium text-text-tertiary">Symbol</span>
          <Input
            value={draft.symbol ?? ""}
            onChange={(e) => update("symbol", e.target.value.toUpperCase() || undefined)}
            placeholder="Optional"
            className="tabular"
          />
        </label>
        <div className="flex flex-col gap-1 col-span-2">
          <span className="text-caption-1-medium text-text-tertiary">Mood</span>
          <div role="radiogroup" aria-label="Mood" className="inline-flex items-center gap-0.5 rounded-2lg bg-background-tertiary-default p-0.5 self-start">
            {MOODS.map((m) => {
              const active = draft.mood === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => update("mood", active ? undefined : m)}
                  className={cn(
                    "inline-flex items-center justify-center h-6 px-2.5 rounded-md text-body-2-medium transition-[background-color,color,box-shadow] duration-150",
                    active
                      ? "bg-segmented-control-selected-background text-text-primary shadow-2xs"
                      : "text-text-secondary hover:text-text-primary"
                  )}
                >
                  {MOOD_LABEL[m] ?? m}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="px-4 py-2 border-b border-separator-border flex items-center gap-2 flex-wrap shrink-0">
        <Tag size={16} className="text-foreground-icon-tertiary" aria-hidden="true" />
        {draft.tags.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => removeTag(t)}
            title="Remove tag"
            className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-caption-1-medium bg-status-blue-background text-status-blue-text hover:bg-status-rose-background hover:text-status-rose-text"
          >
            #{t}
            <XIcon size={12} aria-hidden="true" />
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
          placeholder="Add tag"
          aria-label="Add tag"
          className="h-6 w-32 text-caption-1-regular"
        />
      </div>

      <textarea
        value={draft.body}
        onChange={(e) => update("body", e.target.value)}
        placeholder="What did you see? What was the setup? What went right or wrong? Lessons?"
        aria-label="Entry body"
        className="flex-1 w-full min-h-40 bg-background-primary-default p-4 text-body-2-regular text-text-primary placeholder:text-text-tertiary outline-none resize-none"
      />

      <CardFooter className="justify-between">
        <span className="text-caption-1-medium text-text-tertiary">Markdown supported. Preview after saving.</span>
        <Button variant="secondary" size="sm" onClick={onDelete} className="text-text-secondary hover:text-status-rose-text">
          <Trash2 />
          Delete entry
        </Button>
      </CardFooter>
    </>
  );
}
