"use client";

import {
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  X,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { FeedbackView } from "@/components/admin/feedback-view";
import { AppHeader } from "@/components/common/app-header";
import { LoadError } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/feedback";
import { api } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { cn, RIGOR_LABELS } from "@/lib/utils";
import type {
  AdminInterviewListOut,
  AdminMeOut,
  AdminOverviewOut,
  AdminUserDetailOut,
  AdminUserListOut,
  DailySeriesPoint,
} from "@/types/api";

type TabKey = "overview" | "users" | "interviews" | "feedback";

function formatIST(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatISTShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default function AdminPage() {
  return (
    <Suspense
      fallback={
        <>
          <AppHeader />
          <main id="main" className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
            <div className="space-y-4">
              <Skeleton className="h-10 w-48" />
              <Skeleton className="h-24 w-full" />
            </div>
          </main>
        </>
      }
    >
      <AdminDashboard />
    </Suspense>
  );
}

function AdminDashboard() {
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get("tab") as TabKey) || "overview";

  const [activeTab, setActiveTab] = useState<TabKey>(
    ["overview", "users", "interviews", "feedback"].includes(initialTab) ? initialTab : "overview",
  );
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    let active = true;
    api<AdminMeOut>("/admin/me", { retries: 0 })
      .then((res) => {
        if (!active) return;
        if (res.admin) {
          setIsAdmin(true);
        } else {
          setAuthError(true);
        }
      })
      .catch(() => {
        if (!active) return;
        setAuthError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  function handleSelectTab(tab: TabKey) {
    setActiveTab(tab);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      window.history.replaceState(null, "", url.toString());
    } catch {}
  }

  if (authError) {
    return (
      <>
        <AppHeader />
        <main id="main" className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
          <div className="rounded-lg border border-line bg-surface p-12 text-center">
            <p className="text-lg font-medium text-ink">This page isn&apos;t available.</p>
          </div>
        </main>
      </>
    );
  }

  if (isAdmin === null) {
    return (
      <>
        <AppHeader />
        <main id="main" className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
          <div className="space-y-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-24 w-full" />
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl text-ink">Admin Dashboard</h1>
          <p className="mt-1.5 text-sm text-slate">
            Platform metrics, candidates, interviews, and system health.
          </p>
        </div>

        {/* Tab strip */}
        <div className="mt-6 border-b border-line">
          <nav role="tablist" aria-label="Admin sections" className="-mb-px flex space-x-6 overflow-x-auto">
            {(
              [
                { key: "overview", label: "Overview" },
                { key: "users", label: "Users" },
                { key: "interviews", label: "Interviews" },
                { key: "feedback", label: "Feedback" },
              ] as const
            ).map((t) => {
              const selected = activeTab === t.key;
              return (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={selected}
                  onClick={() => handleSelectTab(t.key)}
                  className={cn(
                    "whitespace-nowrap border-b-2 py-3 text-sm font-medium transition-colors",
                    selected
                      ? "border-ink text-ink font-semibold"
                      : "border-transparent text-slate hover:border-line-strong hover:text-ink",
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Tab Panels */}
        <div className="mt-6">
          {activeTab === "overview" && <OverviewTab />}
          {activeTab === "users" && <UsersTab />}
          {activeTab === "interviews" && <InterviewsTab />}
          {activeTab === "feedback" && <FeedbackView embedded />}
        </div>
      </main>
    </>
  );
}

/* ------------------------------------------------------------------------- */
/* 1. OVERVIEW TAB                                                           */
/* ------------------------------------------------------------------------- */
function OverviewTab() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [data, setData] = useState<AdminOverviewOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    api<AdminOverviewOut>(`/admin/overview?days=${days}`, { retries: 0 })
      .then((res) => {
        if (!active) return;
        setData(res);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [days, nonce]);

  if (error) {
    return <LoadError error={error} onRetry={() => setNonce((n) => n + 1)} />;
  }

  return (
    <div className="space-y-8">
      {/* Date Range Picker */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink">Platform Overview</h2>
        <div className="flex items-center gap-1.5 rounded-md border border-line bg-surface p-1">
          {([7, 30, 90] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                days === d ? "bg-ink text-white" : "text-slate hover:text-ink",
              )}
            >
              Last {d} days
            </button>
          ))}
        </div>
      </div>

      {/* Metric Cards Grid */}
      {loading && !data ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : data ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate">Total Users</p>
            <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">
              {data.users.total}
            </p>
            <p className="mt-1 text-xs text-slate">+{data.users.new_in_range} in {days}d</p>
          </div>

          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate">Active Users</p>
            <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">
              {data.users.active_30d}
            </p>
            <p className="mt-1 text-xs text-slate">
              {data.users.active_24h} in 24h &bull; {data.users.active_7d} in 7d
            </p>
          </div>

          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate">Interviews Started</p>
            <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">
              {data.interviews.started}
            </p>
            <p className="mt-1 text-xs text-slate">{data.interviews.created} created</p>
          </div>

          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate">Completion Rate</p>
            <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">
              {data.interviews.completion_rate.toFixed(1)}%
            </p>
            <p className="mt-1 text-xs text-slate">{data.interviews.completed} completed</p>
          </div>

          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate">Average Score</p>
            <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">
              {data.averages.overall_score > 0 ? `${Math.round(data.averages.overall_score)}/100` : "—"}
            </p>
            <p className="mt-1 text-xs text-slate">Completed interviews</p>
          </div>

          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate">Avg Duration</p>
            <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">
              {Math.round(data.averages.duration_minutes)}m
            </p>
            <p className="mt-1 text-xs text-slate">
              ~{data.averages.questions_answered_per_completed.toFixed(1)} Qs answered
            </p>
          </div>

          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate">User Feedback</p>
            <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">
              {data.feedback.average_rating > 0 ? `${data.feedback.average_rating.toFixed(1)} ★` : "—"}
            </p>
            <p className="mt-1 text-xs text-slate">{data.feedback.count} submissions</p>
          </div>

          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate">Live Now</p>
            <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">
              {data.live_now.count}
            </p>
            <p className="mt-1 text-xs text-slate">Active session(s)</p>
          </div>
        </div>
      ) : null}

      {/* Trend Chart */}
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
          <div>
            <h3 className="font-semibold text-ink">Interview Activity Over Time</h3>
            <p className="text-xs text-slate">Daily volume of interviews started vs. completed (IST)</p>
          </div>
          <div className="flex items-center gap-4 text-xs font-medium">
            <div className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 border-b-2 border-dashed border-slate-500" />
              <span className="text-slate">Started</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-ink" />
              <span className="text-ink">Completed</span>
            </div>
          </div>
        </div>

        <div className="mt-4">
          {data ? (
            <InlineTrendChart series={data.daily_series} />
          ) : (
            <Skeleton className="h-48 w-full" />
          )}
        </div>
      </section>

      {/* Breakdowns Row */}
      {data && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {/* Rigor Breakdown */}
          <div className="rounded-lg border border-line bg-surface p-5">
            <h3 className="font-semibold text-ink">Evaluation Rigor</h3>
            <p className="mt-1 text-xs text-slate">Distribution across difficulty settings</p>
            <div className="mt-4 space-y-3">
              {[
                { key: "casual", label: "Casual" },
                { key: "standard", label: "Standard" },
                { key: "target_bar", label: "Target Bar" },
              ].map((r) => {
                const count = data.breakdowns.by_rigor[r.key] ?? 0;
                const total = Math.max(1, data.interviews.started);
                const pct = Math.round((count / total) * 100);
                return (
                  <div key={r.key} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-ink">{r.label}</span>
                      <span className="tabular-nums text-slate">
                        {count} ({pct}%)
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-line">
                      <div className="h-full bg-ink" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Duration Breakdown */}
          <div className="rounded-lg border border-line bg-surface p-5">
            <h3 className="font-semibold text-ink">Duration Buckets</h3>
            <p className="mt-1 text-xs text-slate">Scheduled interview lengths</p>
            <div className="mt-4 space-y-3">
              {["15", "30", "45", "60"].map((mins) => {
                const count = data.breakdowns.by_duration[mins] ?? 0;
                const total = Math.max(1, data.interviews.started);
                const pct = Math.round((count / total) * 100);
                return (
                  <div key={mins} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-ink">{mins} minutes</span>
                      <span className="tabular-nums text-slate">
                        {count} ({pct}%)
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-line">
                      <div className="h-full bg-slate-600" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Top Roles */}
          <div className="rounded-lg border border-line bg-surface p-5">
            <h3 className="font-semibold text-ink">Top 10 Roles</h3>
            <p className="mt-1 text-xs text-slate">Most practiced target positions</p>
            <div className="mt-4">
              {data.breakdowns.top_roles.length === 0 ? (
                <p className="text-xs text-slate">No interviews recorded yet.</p>
              ) : (
                <ul className="divide-y divide-line text-xs">
                  {data.breakdowns.top_roles.map((tr, idx) => (
                    <li key={idx} className="flex items-center justify-between py-2">
                      <span className="max-w-[180px] truncate font-medium text-ink" title={tr.role}>
                        {tr.role}
                      </span>
                      <span className="font-semibold tabular-nums text-slate">{tr.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* System Health Panel */}
      {data && (
        <section className="rounded-lg border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
            <div>
              <h3 className="font-semibold text-ink">System Health & Telemetry</h3>
              <p className="text-xs text-slate">
                AI model operations, latency, error codes, and live session reliability
              </p>
            </div>
          </div>

          {/* Live Session Telemetry Metrics */}
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-md border border-line bg-paper p-3">
              <p className="text-xs text-slate">Connection Lost</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                {data.health.connection_lost}
              </p>
            </div>
            <div className="rounded-md border border-line bg-paper p-3">
              <p className="text-xs text-slate">Live Connect Failed</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                {data.health.live_connection_failed}
              </p>
            </div>
            <div className="rounded-md border border-line bg-paper p-3">
              <p className="text-xs text-slate">Upload Failed</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                {data.health.recording_upload_failed}
              </p>
            </div>
            <div className="rounded-md border border-line bg-paper p-3">
              <p className="text-xs text-slate">Median TTFR</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                {data.health.median_time_to_first_response_ms
                  ? `${Math.round(data.health.median_time_to_first_response_ms)}ms`
                  : "—"}
              </p>
            </div>
          </div>

          {/* AI Usage Operations Table */}
          <div className="mt-6">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate">AI Model Operations</h4>
            {data.health.ai_usage.length === 0 ? (
              <p className="mt-2 text-xs text-slate">No AI operations recorded in this window.</p>
            ) : (
              <div className="mt-2 overflow-x-auto rounded border border-line">
                <table className="w-full text-left text-xs">
                  <thead className="bg-paper text-slate border-b border-line font-medium">
                    <tr>
                      <th className="px-3 py-2">Operation</th>
                      <th className="px-3 py-2">Model</th>
                      <th className="px-3 py-2">Calls</th>
                      <th className="px-3 py-2">Failures</th>
                      <th className="px-3 py-2">Failure Rate</th>
                      <th className="px-3 py-2">Avg Latency</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.health.ai_usage.map((row, idx) => {
                      const failRate = row.calls > 0 ? (row.failures / row.calls) * 100 : 0;
                      return (
                        <tr key={idx} className="hover:bg-sand-50/50">
                          <td className="px-3 py-2 font-medium text-ink">{row.operation}</td>
                          <td className="px-3 py-2 text-slate font-mono">{row.model}</td>
                          <td className="px-3 py-2 tabular-nums text-ink">{row.calls}</td>
                          <td className="px-3 py-2 tabular-nums text-ink">
                            {row.failures > 0 ? (
                              <span className="text-signal font-semibold">{row.failures}</span>
                            ) : (
                              "0"
                            )}
                          </td>
                          <td className="px-3 py-2 tabular-nums text-slate">
                            {failRate > 0 ? `${failRate.toFixed(1)}%` : "0%"}
                          </td>
                          <td className="px-3 py-2 tabular-nums text-slate">
                            {Math.round(row.avg_latency_ms)}ms
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Top Error Codes */}
          {data.health.top_error_codes.length > 0 && (
            <div className="mt-6">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate">Top AI Error Codes</h4>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.health.top_error_codes.map((ec, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 rounded border border-line bg-paper px-3 py-1 text-xs"
                  >
                    <span className="font-mono text-ink">{ec.error_code}</span>
                    <span className="rounded-full bg-line px-1.5 py-0.5 text-[10px] font-semibold text-slate">
                      {ec.count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* INLINE SVG TREND CHART                                                    */
/* ------------------------------------------------------------------------- */
function InlineTrendChart({ series }: { series: DailySeriesPoint[] }) {
  if (!series || series.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-slate">
        No interview activity recorded for this period.
      </div>
    );
  }

  const width = 760;
  const height = 200;
  const paddingLeft = 40;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 30;

  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;

  const maxVal = Math.max(
    5,
    ...series.map((s) => Math.max(s.interviews_started, s.interviews_completed)),
  );

  const pointsCount = series.length;
  const stepX = pointsCount > 1 ? chartW / (pointsCount - 1) : chartW / 2;

  // Build coordinate arrays
  const startedPoints = series.map((pt, i) => {
    const x = paddingLeft + (pointsCount > 1 ? i * stepX : chartW / 2);
    const y = paddingTop + chartH - (pt.interviews_started / maxVal) * chartH;
    return { x, y, pt };
  });

  const completedPoints = series.map((pt, i) => {
    const x = paddingLeft + (pointsCount > 1 ? i * stepX : chartW / 2);
    const y = paddingTop + chartH - (pt.interviews_completed / maxVal) * chartH;
    return { x, y, pt };
  });

  const startedPath = startedPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const completedPath = completedPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

  // Grid ticks (0%, 25%, 50%, 75%, 100%)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((pct) => ({
    val: Math.round(maxVal * pct),
    y: paddingTop + chartH - pct * chartH,
  }));

  // X ticks: pick at most 6 evenly spaced labels
  const labelInterval = Math.max(1, Math.floor(pointsCount / 6));
  const xLabels = series
    .map((pt, idx) => ({ pt, idx }))
    .filter((_, idx) => idx % labelInterval === 0 || idx === pointsCount - 1);

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full min-w-[550px] overflow-visible text-slate"
        aria-label="Interview trend line chart"
      >
        {/* Y Gridlines and labels */}
        {yTicks.map((t, idx) => (
          <g key={idx}>
            <line
              x1={paddingLeft}
              y1={t.y}
              x2={width - paddingRight}
              y2={t.y}
              stroke="currentColor"
              strokeOpacity="0.15"
              strokeDasharray="2 2"
            />
            <text
              x={paddingLeft - 8}
              y={t.y + 4}
              fontSize="10"
              textAnchor="end"
              fill="currentColor"
              className="tabular-nums font-mono"
            >
              {t.val}
            </text>
          </g>
        ))}

        {/* X labels */}
        {xLabels.map((item) => {
          const x = paddingLeft + (pointsCount > 1 ? item.idx * stepX : chartW / 2);
          return (
            <text
              key={item.idx}
              x={x}
              y={height - 8}
              fontSize="10"
              textAnchor="middle"
              fill="currentColor"
              className="tabular-nums"
            >
              {formatISTShort(item.pt.date)}
            </text>
          );
        })}

        {/* Line: Started (dashed, slate) */}
        <path
          d={startedPath}
          fill="none"
          stroke="#64748b"
          strokeWidth="2"
          strokeDasharray="4 3"
          strokeLinejoin="round"
        />

        {/* Line: Completed (solid, ink) */}
        <path
          d={completedPath}
          fill="none"
          stroke="#0f172a"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Points for hover / title */}
        {startedPoints.map((p, idx) => (
          <circle
            key={`s-${idx}`}
            cx={p.x}
            cy={p.y}
            r="3"
            fill="#64748b"
            className="cursor-pointer transition-transform hover:scale-150"
          >
            <title>{`${p.pt.date}: ${p.pt.interviews_started} started`}</title>
          </circle>
        ))}

        {completedPoints.map((p, idx) => (
          <circle
            key={`c-${idx}`}
            cx={p.x}
            cy={p.y}
            r="3.5"
            fill="#0f172a"
            className="cursor-pointer transition-transform hover:scale-150"
          >
            <title>{`${p.pt.date}: ${p.pt.interviews_completed} completed`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* 2. USERS TAB                                                              */
/* ------------------------------------------------------------------------- */
function UsersTab() {
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const [data, setData] = useState<AdminUserListOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (search.trim()) {
      params.set("search", search.trim());
    }

    api<AdminUserListOut>(`/admin/users?${params.toString()}`, { retries: 0 })
      .then((res) => {
        if (!active) return;
        setData(res);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [offset, search, nonce]);

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setOffset(0);
    setSearch(searchInput);
  }

  function handleExportCsv() {
    if (!data || data.items.length === 0) return;
    const headers = [
      "User ID",
      "Email",
      "Display Name",
      "Signed Up (IST)",
      "Last Sign In (IST)",
      "Total Interviews",
      "Completed Interviews",
      "Last Interview (IST)",
      "Average Score",
      "Feedback Count",
    ];
    const rows = data.items.map((u) => [
      u.user_id,
      u.email || "",
      u.display_name || "",
      formatIST(u.signed_up_at),
      formatIST(u.last_sign_in_at),
      u.interviews_total,
      u.interviews_completed,
      formatIST(u.last_interview_at),
      u.average_score !== null ? Math.round(u.average_score) : "",
      u.feedback_count,
    ]);
    downloadCsv("admin-users", headers, rows);
  }

  return (
    <div className="space-y-6">
      {/* Search and Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate" />
            <input
              type="text"
              placeholder="Search by candidate email..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-9 w-64 rounded-md border border-line bg-surface pl-9 pr-3 text-xs text-ink placeholder:text-slate focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink sm:w-80"
            />
          </div>
          <Button variant="secondary" size="sm" type="submit">
            Search
          </Button>
          {search && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setSearchInput("");
                setSearch("");
                setOffset(0);
              }}
            >
              Clear
            </Button>
          )}
        </form>

        <Button
          variant="secondary"
          size="sm"
          onClick={handleExportCsv}
          disabled={!data || data.items.length === 0}
          className="flex items-center gap-1.5"
          aria-label="Export CSV"
        >
          <Download className="size-3.5" />
          <span>Export CSV</span>
        </Button>
      </div>

      {error && <LoadError error={error} onRetry={() => setNonce((n) => n + 1)} />}

      {/* Table */}
      <section aria-label="Users table">
        {loading && !data ? (
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : !loading && data && data.items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
            <p className="font-display text-xl font-semibold text-ink">No candidates found.</p>
            <p className="mt-1 text-xs text-slate">
              {search ? "Try refining your search term." : "Candidates will appear here as they register."}
            </p>
          </div>
        ) : data ? (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface shadow-xs">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-paper uppercase tracking-wider text-slate">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Candidate</th>
                  <th scope="col" className="px-4 py-3 font-medium">Signed Up (IST)</th>
                  <th scope="col" className="px-4 py-3 font-medium">Last Active (IST)</th>
                  <th scope="col" className="px-4 py-3 font-medium">Interviews</th>
                  <th scope="col" className="px-4 py-3 font-medium">Completed</th>
                  <th scope="col" className="px-4 py-3 font-medium">Avg Score</th>
                  <th scope="col" className="px-4 py-3 font-medium">Feedback</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((u) => (
                  <tr
                    key={u.user_id}
                    onClick={() => setSelectedUserId(u.user_id)}
                    className="cursor-pointer transition-colors hover:bg-sand-50/50"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{u.email || "—"}</div>
                      <div className="font-mono text-[10px] text-slate">{u.user_id}</div>
                    </td>
                    <td className="px-4 py-3 text-slate whitespace-nowrap">{formatIST(u.signed_up_at)}</td>
                    <td className="px-4 py-3 text-slate whitespace-nowrap">
                      {formatIST(u.last_interview_at || u.last_sign_in_at)}
                    </td>
                    <td className="px-4 py-3 tabular-nums font-semibold text-ink">{u.interviews_total}</td>
                    <td className="px-4 py-3 tabular-nums text-slate">{u.interviews_completed}</td>
                    <td className="px-4 py-3 tabular-nums text-ink">
                      {u.average_score !== null ? `${Math.round(u.average_score)}/100` : "—"}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate">{u.feedback_count}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-medium text-ink underline underline-offset-2">
                        View
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* Pagination */}
        {data && data.total > limit && (
          <div className="mt-4 flex items-center justify-between text-xs text-slate">
            <span>
              Showing {offset + 1}–{Math.min(offset + limit, data.total)} of {data.total} candidates
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOffset((o) => Math.max(0, o - limit))}
                disabled={offset === 0}
              >
                <ChevronLeft className="size-3.5" /> Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOffset((o) => o + limit)}
                disabled={offset + limit >= data.total}
              >
                Next <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* User Detail Drawer */}
      {selectedUserId && (
        <UserDetailDrawer userId={selectedUserId} onClose={() => setSelectedUserId(null)} />
      )}
    </div>
  );
}

/* User Detail Drawer Component */
function UserDetailDrawer({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [user, setUser] = useState<AdminUserDetailOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    api<AdminUserDetailOut>(`/admin/users/${userId}`, { retries: 0 })
      .then((res) => {
        if (!active) return;
        setUser(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [userId]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-drawer-title"
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs transition-opacity"
    >
      <div className="relative flex h-full w-full max-w-2xl flex-col bg-surface shadow-2xl">
        {/* Drawer Header */}
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div>
            <h2 id="user-drawer-title" className="text-lg font-semibold text-ink">
              Candidate Profile
            </h2>
            <p className="font-mono text-xs text-slate">{userId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="rounded p-1 text-slate hover:bg-paper hover:text-ink"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {/* Privacy Notice */}
          <div className="rounded-md border border-line bg-paper px-4 py-3 text-xs text-slate">
            <span className="font-semibold text-ink">Privacy Safeguard:</span> Admin access is
            read-only metadata. Transcripts, resumes, and candidate answers are strictly confidential
            and never displayed.
          </div>

          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : error ? (
            <LoadError error={error} />
          ) : user ? (
            <>
              {/* Profile Details */}
              <div className="grid grid-cols-2 gap-4 rounded-lg border border-line bg-surface p-4 sm:grid-cols-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate">Email</p>
                  <p className="mt-1 truncate text-xs font-medium text-ink">{user.email || "—"}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate">Registered (IST)</p>
                  <p className="mt-1 text-xs text-slate">{formatIST(user.signed_up_at)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate">Interviews</p>
                  <p className="mt-1 text-xs font-semibold text-ink">
                    {user.interviews_total} ({user.interviews_completed} completed)
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate">Avg Score</p>
                  <p className="mt-1 text-xs font-semibold text-ink">
                    {user.average_score !== null ? `${Math.round(user.average_score)}/100` : "—"}
                  </p>
                </div>
              </div>

              {/* Interview History */}
              <div>
                <h3 className="font-semibold text-ink text-sm">Interview History</h3>
                <p className="text-xs text-slate">Candidate interview timeline and outcomes</p>

                {user.interviews.length === 0 ? (
                  <p className="mt-4 text-xs text-slate">No interviews created yet.</p>
                ) : (
                  <div className="mt-3 overflow-x-auto rounded border border-line">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-line bg-paper text-slate">
                        <tr>
                          <th className="px-3 py-2 font-medium">Date (IST)</th>
                          <th className="px-3 py-2 font-medium">Role</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Score</th>
                          <th className="px-3 py-2 font-medium">Feedback</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {user.interviews.map((iv) => (
                          <tr key={iv.id} className="hover:bg-sand-50/50">
                            <td className="px-3 py-2.5 text-slate whitespace-nowrap">
                              {formatIST(iv.created_at)}
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="font-medium text-ink">{iv.job_role}</div>
                              <div className="text-[10px] text-slate">
                                {iv.duration_minutes}m &bull; {RIGOR_LABELS[iv.evaluation_rigor] || iv.evaluation_rigor}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <InterviewStatusBadge status={iv.status} />
                              {iv.failure_code && (
                                <div className="mt-0.5 text-[10px] text-signal font-mono">
                                  {iv.failure_code}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2.5 tabular-nums text-ink">
                              {iv.overall_score !== null ? `${Math.round(iv.overall_score)}/100` : "—"}
                            </td>
                            <td className="px-3 py-2.5">
                              {iv.feedback_rating !== null ? (
                                <div>
                                  <span className="font-medium text-ink">★ {iv.feedback_rating}</span>
                                  {iv.feedback_comments && (
                                    <p className="max-w-xs truncate text-[10px] text-slate">
                                      {iv.feedback_comments}
                                    </p>
                                  )}
                                </div>
                              ) : (
                                <span className="text-slate">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>

        {/* Drawer Footer */}
        <div className="border-t border-line px-6 py-3 text-right">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* 3. INTERVIEWS TAB                                                         */
/* ------------------------------------------------------------------------- */
function InterviewsTab() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [daysFilter, setDaysFilter] = useState<string>("30");
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const [data, setData] = useState<AdminInterviewListOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (statusFilter) params.set("status", statusFilter);
    if (daysFilter) params.set("days", daysFilter);

    api<AdminInterviewListOut>(`/admin/interviews?${params.toString()}`, { retries: 0 })
      .then((res) => {
        if (!active) return;
        setData(res);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [offset, statusFilter, daysFilter, nonce]);

  function handleExportCsv() {
    if (!data || data.items.length === 0) return;
    const headers = [
      "Interview ID",
      "Date (IST)",
      "User Email",
      "User ID",
      "Job Role",
      "Duration (min)",
      "Rigor",
      "Status",
      "Failure Code",
      "Questions Answered",
      "Questions Skipped",
      "Questions Total",
      "Score",
      "Feedback Rating",
    ];
    const rows = data.items.map((i) => [
      i.id,
      formatIST(i.created_at),
      i.user_email || "",
      i.user_id,
      i.job_role,
      i.duration_minutes,
      RIGOR_LABELS[i.evaluation_rigor] || i.evaluation_rigor,
      i.status,
      i.failure_code || "",
      i.questions_answered,
      i.questions_skipped,
      i.questions_total,
      i.overall_score !== null ? Math.round(i.overall_score) : "",
      i.feedback_rating !== null ? i.feedback_rating : "",
    ]);
    downloadCsv("admin-interviews", headers, rows);
  }

  return (
    <div className="space-y-6">
      {/* Filter Row & CSV Export */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Status selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate">Status:</span>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setOffset(0);
              }}
              className="h-8 rounded border border-line bg-surface px-2 text-xs text-ink focus:border-ink focus:outline-none"
            >
              <option value="">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="in_progress">In Progress</option>
              <option value="created">Created</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          {/* Days selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate">Range:</span>
            <select
              value={daysFilter}
              onChange={(e) => {
                setDaysFilter(e.target.value);
                setOffset(0);
              }}
              className="h-8 rounded border border-line bg-surface px-2 text-xs text-ink focus:border-ink focus:outline-none"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="">All time</option>
            </select>
          </div>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={handleExportCsv}
          disabled={!data || data.items.length === 0}
          className="flex items-center gap-1.5"
          aria-label="Export CSV"
        >
          <Download className="size-3.5" />
          <span>Export CSV</span>
        </Button>
      </div>

      {error && <LoadError error={error} onRetry={() => setNonce((n) => n + 1)} />}

      {/* Table */}
      <section aria-label="Interviews table">
        {loading && !data ? (
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : !loading && data && data.items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
            <p className="font-display text-xl font-semibold text-ink">No interviews found.</p>
            <p className="mt-1 text-xs text-slate">Try adjusting your filters above.</p>
          </div>
        ) : data ? (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface shadow-xs">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-paper uppercase tracking-wider text-slate">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Date (IST)</th>
                  <th scope="col" className="px-4 py-3 font-medium">Candidate</th>
                  <th scope="col" className="px-4 py-3 font-medium">Role</th>
                  <th scope="col" className="px-4 py-3 font-medium">Length & Rigor</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Questions</th>
                  <th scope="col" className="px-4 py-3 font-medium">Score</th>
                  <th scope="col" className="px-4 py-3 font-medium">Rating</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((iv) => (
                  <tr key={iv.id} className="hover:bg-sand-50/50">
                    <td className="px-4 py-3 text-slate whitespace-nowrap">{formatIST(iv.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{iv.user_email || "—"}</div>
                      <div className="font-mono text-[10px] text-slate">{iv.user_id.slice(0, 8)}...</div>
                    </td>
                    <td className="px-4 py-3 font-medium text-ink">{iv.job_role}</td>
                    <td className="px-4 py-3 text-slate whitespace-nowrap">
                      {iv.duration_minutes}m &bull; {RIGOR_LABELS[iv.evaluation_rigor] || iv.evaluation_rigor}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <InterviewStatusBadge status={iv.status} />
                      {iv.failure_code && (
                        <div className="mt-0.5 text-[10px] text-signal font-mono">
                          {iv.failure_code}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate">
                      {iv.questions_answered}/{iv.questions_total}
                      {iv.questions_skipped > 0 && ` (${iv.questions_skipped} skipped)`}
                    </td>
                    <td className="px-4 py-3 tabular-nums font-semibold text-ink">
                      {iv.overall_score !== null ? `${Math.round(iv.overall_score)}/100` : "—"}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {iv.feedback_rating !== null ? (
                        <span className="font-medium text-ink">★ {iv.feedback_rating}</span>
                      ) : (
                        <span className="text-slate">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* Pagination */}
        {data && data.total > limit && (
          <div className="mt-4 flex items-center justify-between text-xs text-slate">
            <span>
              Showing {offset + 1}–{Math.min(offset + limit, data.total)} of {data.total} interviews
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOffset((o) => Math.max(0, o - limit))}
                disabled={offset === 0}
              >
                <ChevronLeft className="size-3.5" /> Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOffset((o) => o + limit)}
                disabled={offset + limit >= data.total}
              >
                Next <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/* Helper Badge for Interview Status */
function InterviewStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <Badge tone="go">Completed</Badge>;
    case "in_progress":
      return <Badge tone="wait">In Progress</Badge>;
    case "failed":
      return <Badge tone="signal">Failed</Badge>;
    case "cancelled":
      return <Badge tone="neutral">Cancelled</Badge>;
    default:
      return <Badge tone="neutral">{status}</Badge>;
  }
}
