import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

type Tone = "info" | "error" | "success" | "warning";

const tones: Record<Tone, string> = {
  info: "border-line-strong bg-surface text-ink",
  error: "border-signal/30 bg-signal-soft text-signal",
  success: "border-go/30 bg-go-soft text-go",
  warning: "border-wait/30 bg-mark-soft text-wait",
};

const icons: Record<Tone, React.ComponentType<{ className?: string }>> = {
  info: Info,
  error: AlertTriangle,
  success: CheckCircle2,
  warning: AlertTriangle,
};

export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title?: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const Icon = icons[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex gap-3 rounded-md border px-4 py-3 text-sm", tones[tone], className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-ink/80 [&_a]:underline">{children}</div>}
        {action && <div className="pt-1">{action}</div>}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-line/80", className)} />;
}

export function Badge({
  className,
  children,
  tone = "neutral",
}: {
  className?: string;
  children: React.ReactNode;
  tone?: "neutral" | "go" | "wait" | "signal" | "ink";
}) {
  const map = {
    neutral: "bg-line/70 text-ink",
    go: "bg-go-soft text-go",
    wait: "bg-mark-soft text-wait",
    signal: "bg-signal-soft text-signal",
    ink: "bg-ink text-white",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        map[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-line"
    >
      <div className="h-full rounded-full bg-ink transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}
