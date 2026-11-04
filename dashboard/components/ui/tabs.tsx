"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

// BoardUI underline tabs (components/base/tabs/tabs.tsx): the strip sits on
// a hairline, the active tab paints a 2px accent underline over it.
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex items-stretch gap-1 px-2 border-b border-separator-border", className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "relative inline-flex items-center gap-2 px-2.5 h-10 text-body-2-regular text-text-secondary transition-colors rounded-t-md",
      "hover:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring",
      "disabled:pointer-events-none disabled:opacity-50",
      "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors",
      "data-[state=active]:text-accent-600 data-[state=active]:text-body-2-medium data-[state=active]:after:bg-accent-600",
      "[&_[data-count]]:rounded-sm [&_[data-count]]:px-1 [&_[data-count]]:py-px [&_[data-count]]:text-caption-1-medium [&_[data-count]]:bg-background-tertiary-default [&_[data-count]]:text-text-secondary",
      "data-[state=active]:[&_[data-count]]:bg-accent-100 data-[state=active]:[&_[data-count]]:text-accent-600",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  // Consumers own height + overflow explicitly.
  <TabsPrimitive.Content ref={ref} className={cn("focus-visible:outline-none", className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
