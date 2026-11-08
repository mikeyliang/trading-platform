'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { RiAlertFill as AlertTriangle, RiRefreshLine as RefreshCw } from "@remixicon/react";
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadingSpinner } from '@/components/ui/loading-spinner';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** Optional human-readable name shown in the fallback header. */
  label?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Dashboard Error:', error, errorInfo);
  }

  private retry = () => this.setState({ hasError: false, error: undefined });

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          aria-live="assertive"
          className="flex flex-col items-center justify-center gap-3 p-6 mx-3 my-4 rounded-md border border-status-rose-text bg-status-rose-background text-center animate-fade-in"
        >
          <div className="w-9 h-9 rounded-full bg-status-rose-background border border-status-rose-text flex items-center justify-center">
            <AlertTriangle size={16} className="text-status-rose-text" />
          </div>
          <div className="space-y-1">
            <p className="text-caption-1-regular font-medium text-text-primary">
              {this.props.label ? `${this.props.label} failed to load` : 'Something went wrong'}
            </p>
            <p className="text-caption-1-regular text-text-tertiary max-w-md leading-relaxed">
              {this.state.error?.message || 'An unexpected error occurred while rendering this section.'}
            </p>
          </div>
          <button
            type="button"
            onClick={this.retry}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm border border-separator-border bg-background-secondary-default text-caption-1-regular text-text-secondary hover:bg-background-tertiary-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus-ring transition-colors"
          >
            <RefreshCw size={14} />
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Inline loading state for sections that fit into a column-flow layout.
 * Uses the same dark tokens as the rest of the dashboard.
 */
export function LoadingState({ message = 'Loading...', className }: { message?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex items-center justify-center gap-2 px-3 py-6 text-caption-1-regular text-text-tertiary', className)}
    >
      <LoadingSpinner size="sm" />
      <span>{message}</span>
    </div>
  );
}

/**
 * Skeleton placeholder for a card-shaped section. Mirrors the real
 * `Card` chrome (border + 28px header + content padding) so the layout
 * doesn't jump when content arrives.
 */
export function CardSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn('rounded-md border border-separator-border bg-background-primary-default overflow-hidden', className)}
    >
      <div className="flex items-center gap-2 px-3 h-7 border-b border-separator-border">
        <Skeleton className="h-2.5 w-24" />
      </div>
      <div className="p-3 space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-3"
            style={{ width: `${88 - i * 12}%` }}
          />
        ))}
      </div>
    </div>
  );
}
