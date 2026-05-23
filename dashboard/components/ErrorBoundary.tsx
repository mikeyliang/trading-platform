'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
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
          className="flex flex-col items-center justify-center gap-3 p-6 mx-3 my-4 rounded-md border border-down/30 bg-down/5 text-center animate-fade-in"
        >
          <div className="w-9 h-9 rounded-full bg-down/10 border border-down/30 flex items-center justify-center">
            <AlertTriangle size={16} className="text-down" strokeWidth={2} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-text-primary">
              {this.props.label ? `${this.props.label} failed to load` : 'Something went wrong'}
            </p>
            <p className="text-[11px] text-text-muted max-w-md leading-relaxed">
              {this.state.error?.message || 'An unexpected error occurred while rendering this section.'}
            </p>
          </div>
          <button
            type="button"
            onClick={this.retry}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm border border-border bg-surface-2 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent transition-colors"
          >
            <RefreshCw size={11} />
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
      className={cn('flex items-center justify-center gap-2 px-3 py-6 text-[11px] text-text-muted', className)}
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
      className={cn('rounded-md border border-border bg-surface overflow-hidden', className)}
    >
      <div className="flex items-center gap-2 px-3 h-7 border-b border-border/60">
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
