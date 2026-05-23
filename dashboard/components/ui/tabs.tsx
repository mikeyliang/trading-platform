"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex items-stretch border-b border-border bg-surface", className)}
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
      // Pro-terminal tab trigger: uppercase 10px tracking-wider label
      // matching the rest of the page's section markers, with an
      // accent-rule active state and a subtle hover lift. Bumped padding
      // to py-2.5 for finger-friendly click targets without bloat.
      "inline-flex items-center gap-1.5 px-3 py-2.5 text-[10px] uppercase tracking-wider font-medium border-b-2 border-transparent text-text-muted transition-colors hover:text-text-secondary hover:bg-surface-2/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-accent data-[state=active]:text-text-primary data-[state=active]:bg-surface-2/30",
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
  // `flex-1 overflow-auto` were the previous defaults; they collapsed the
  // content to 0 height when the parent wasn't a flex container, which is
  // most of the time. Consumers now own height + overflow explicitly.
  <TabsPrimitive.Content
    ref={ref}
    className={cn("focus-visible:outline-none", className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
