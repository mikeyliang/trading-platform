"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Info, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaField>;
  defaults?: Record<string, unknown>;
  $defs?: Record<string, JsonSchemaField>;
  required?: string[];
}

export interface JsonSchemaField {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: (string | number)[];
  anyOf?: { const?: string | number; type?: string }[];
  group?: string;
  // Field's json_schema_extra fields land at the top level
  [key: string]: unknown;
}

interface Props {
  schema: JsonSchema | null;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  className?: string;
  showReset?: boolean;
}

export function SchemaForm({ schema, value, onChange, className, showReset = true }: Props) {
  if (!schema || !schema.properties) {
    return (
      <div className="text-[11px] text-text-muted py-4 text-center">
        No tunable parameters for this strategy.
      </div>
    );
  }

  const groups = groupFields(schema);
  const defaults = schema.defaults ?? {};
  const dirty =
    Object.keys(defaults).some((k) => value[k] !== undefined && value[k] !== defaults[k]);

  const reset = () => onChange({});

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {showReset && (
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            Parameters
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={reset}
            disabled={!dirty}
            className="h-6 text-[10px]"
          >
            <RotateCcw />
            Reset
          </Button>
        </div>
      )}

      {groups.map(([group, fields]) => (
        <div key={group} className="flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wider text-text-muted border-b border-border/60 pb-1">
            {group}
          </div>
          <div className="flex flex-col gap-2">
            {fields.map(([name, field]) => (
              <FieldRow
                key={name}
                name={name}
                field={field}
                value={value[name] ?? field.default ?? defaults[name]}
                onChange={(v) => onChange({ ...value, [name]: v })}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FieldRow({
  name,
  field,
  value,
  onChange,
}: {
  name: string;
  field: JsonSchemaField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (field.title as string) || prettyName(name);
  const enumValues = resolveEnum(field);
  const isNumber = field.type === "integer" || field.type === "number";
  const step = field.type === "integer" ? 1 : 0.01;

  return (
    <div className="flex items-center justify-between gap-3 min-h-[26px]">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[11px] text-text-secondary truncate">{label}</span>
        {field.description && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Info size={11} className="text-text-muted shrink-0 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              {field.description}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="shrink-0">
        {enumValues ? (
          <Select value={String(value ?? "")} onValueChange={onChange}>
            <SelectTrigger className="h-7 w-28 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {enumValues.map((v) => (
                <SelectItem key={String(v)} value={String(v)}>
                  {String(v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : isNumber ? (
          <Input
            type="number"
            step={step}
            min={field.minimum}
            max={field.maximum}
            value={(value ?? "") as number | string}
            onChange={(e) => onChange(e.target.value === "" ? "" : +e.target.value)}
            className="h-7 w-20 text-right tabular text-[11px]"
          />
        ) : (
          <Input
            value={(value ?? "") as string}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 w-28 text-[11px]"
          />
        )}
      </div>
    </div>
  );
}

function prettyName(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function resolveEnum(field: JsonSchemaField): (string | number)[] | null {
  if (field.enum && field.enum.length) return field.enum;
  if (field.anyOf) {
    const vals = field.anyOf
      .map((v) => v.const)
      .filter((v): v is string | number => v !== undefined);
    if (vals.length) return vals;
  }
  return null;
}

function groupFields(schema: JsonSchema): [string, [string, JsonSchemaField][]][] {
  const props = schema.properties ?? {};
  const buckets = new Map<string, [string, JsonSchemaField][]>();
  for (const [name, field] of Object.entries(props)) {
    const group = (field.group as string) || "Parameters";
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group)!.push([name, field]);
  }
  return Array.from(buckets.entries());
}
