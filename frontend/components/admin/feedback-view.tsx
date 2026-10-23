"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";

import { LoadError } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/feedback";
import { api, ApiError } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { cn, RIGOR_LABELS } from "@/lib/utils";
import type { FeedbackItemOut, FeedbackListOut, FeedbackSummaryOut } from "@/types/api";

function formatIST(iso: string): string {
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

export function FeedbackView({ embedded = false }: { embedded?: boolean }) {
  const [summary, setSummary] = useState<FeedbackSummaryOut | null>(null);
  const [items, setItems] = useState<FeedbackItemOut[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [is404, setIs404] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [ratingFilter, setRatingFilter] = useState<number | null>(null);
  const [onlyWithComments, setOnlyWithComments] = useState(false);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    params.set("limit", "50");
    params.set("offset", "0");
    if (ratingFilter !== null) {
      params.set("rating", String(ratingFilter));
    }
    if (onlyWithComments) {
      params.set("has_comments", "true");
    }

    Promise.all([
      api<FeedbackSummaryOut>("/admin/feedback/summary", { retries: 0 }),
      api<FeedbackListOut>(`/admin/feedback?${params.toString()}`, { retries: 0 }),
    ])
      .then(([summaryData, listData]) => {
        if (!active) return;
        setSummary(summaryData);
        setItems(listData.items);
        setTotal(listData.total);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) {
          setIs404(true);
        }
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [ratingFilter, onlyWithComments, reloadNonce]);

  async function handleLoadMore() {
    setLoadingMore(true);
    const params = new URLSearchParams();
    params.set("limit", "50");
    params.set("offset", String(items.length));
    if (ratingFilter !== null) {
      params.set("rating", String(ratingFilter));
    }
    if (onlyWithComments) {
      params.set("has_comments", "true");
    }

    try {
      const data = await api<FeedbackListOut>(`/admin/feedback?${params.toString()}`, { retries: 0 });
      setTotal(data.total);
      setItems((prev) => [...prev, ...data.items]);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        setIs404(true);
      }
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoadingMore(false);
    }
  }

  function handleFilterRating(r: number | null) {
    setLoading(true);
    setRatingFilter(r);
  }

  function handleToggleComments(checked: boolean) {
    setLoading(true);
    setOnlyWithComments(checked);
  }

  function handleReload() {
    setLoading(true);
    setReloadNonce((n) => n + 1);
  }

  function handleExportCsv() {
    const headers = [
      "Date (IST)",
      "User Email",
      "Rating",
      "Comment",
      "Role",
      "Duration (min)",
      "Rigor",
      "Score",
      "Interview ID",
    ];
    const rows = items.map((item) => [
      formatIST(item.submitted_at),
      item.user_email || "",
      item.rating,
      item.comments || "",
      item.job_role,
      item.duration_minutes,
      RIGOR_LABELS[item.evaluation_rigor] || item.evaluation_rigor,
      item.overall_score !== null && item.overall_score !== undefined ? Math.round(item.overall_score) : "",
      item.interview_id,
    ]);
    downloadCsv("admin-feedback", headers, rows);
  }

  if (is404) {
    return (
      <div className="rounded-lg border border-line bg-surface p-12 text-center">
        <p className="text-lg font-medium text-ink">This page isn&apos;t available.</p>
      </div>
    );
  }

  return (
    <div className={cn(embedded ? "pt-2" : "")}>
      {!embedded && (
        <div>
          <h1 className="text-4xl font-semibold">User Feedback</h1>
          <p className="mt-2 text-slate">Read feedback and ratings submitted by candidates after their interviews.</p>
        </div>
      )}

      {error && (
        <div className="mt-6">
          <LoadError error={error} onRetry={handleReload} />
        </div>
      )}

      {/* Summary Row */}
      <section aria-label="Feedback summary" className={cn(embedded ? "mt-4" : "mt-8")}>
        {loading && !summary ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : summary ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate">Total feedback</p>
              <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">
                {summary.total_responses}
              </p>
            </div>
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate">Average rating</p>
              <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">
                {summary.total_responses > 0 ? `${summary.average_rating.toFixed(1)} / 5` : "—"}
              </p>
            </div>
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate">Unhappy (1–2 ★)</p>
              <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">
                {(summary.rating_counts[1] ?? 0) + (summary.rating_counts[2] ?? 0)}
              </p>
            </div>
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate">Last 7 days</p>
              <p className="mt-2 font-display text-3xl font-semibold tabular-nums text-ink">{summary.last_7_days}</p>
            </div>
          </div>
        ) : null}
      </section>

      {/* Filters and CSV Export */}
      <section aria-label="Filters" className="mt-8 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by rating">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wider text-slate">Rating:</span>
          {[null, 5, 4, 3, 2, 1].map((r) => {
            const active = ratingFilter === r;
            return (
              <button
                key={r ?? "all"}
                type="button"
                onClick={() => handleFilterRating(r)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  active
                    ? "bg-ink text-white"
                    : "border border-line bg-surface text-slate hover:border-line-strong hover:text-ink",
                )}
                aria-pressed={active}
              >
                {r === null ? "All" : `${r} ★`}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-slate hover:text-ink">
            <input
              type="checkbox"
              checked={onlyWithComments}
              onChange={(e) => handleToggleComments(e.target.checked)}
              className="h-4 w-4 rounded border-line text-ink focus:ring-ink"
            />
            <span className="font-medium">Only with comments</span>
          </label>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportCsv}
            disabled={items.length === 0}
            className="flex items-center gap-1.5"
            aria-label="Export CSV"
          >
            <Download className="size-3.5" />
            <span>Export CSV</span>
          </Button>
        </div>
      </section>

      {/* Table / List */}
      <section aria-label="Feedback entries" className="mt-6">
        {loading && items.length === 0 ? (
          <div className="space-y-3" aria-label="Loading feedback entries">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : !loading && items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
            <p className="mx-auto max-w-md font-display text-xl font-semibold text-ink">No feedback yet.</p>
            <p className="mt-2 text-sm text-slate">
              Feedback submitted by candidates after their interviews will appear here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface shadow-xs">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-paper text-xs uppercase tracking-wider text-slate">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Date (IST)
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    User
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Rating
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Comment
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Role
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Length
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Rigor
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Score
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((item, idx) => (
                  <tr key={`${item.interview_id}-${idx}`} className="hover:bg-sand-50/50">
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate">
                      {formatIST(item.submitted_at)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate">{item.user_email || "—"}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge tone={item.rating >= 4 ? "go" : item.rating === 3 ? "wait" : "signal"}>
                        ★ {item.rating}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 min-w-[200px] max-w-md break-words whitespace-pre-wrap text-ink">
                      {item.comments && item.comments.trim().length > 0 ? (
                        item.comments
                      ) : (
                        <span className="text-slate">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap font-medium text-ink">{item.job_role}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate">{item.duration_minutes}m</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate">
                      {RIGOR_LABELS[item.evaluation_rigor] || item.evaluation_rigor}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {item.overall_score !== null && item.overall_score !== undefined ? (
                        <span className="font-semibold tabular-nums text-ink">
                          {Math.round(item.overall_score)}/100
                        </span>
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

        {/* Pagination */}
        {!loading && items.length < total && (
          <div className="mt-6 flex justify-center">
            <Button variant="secondary" onClick={handleLoadMore} loading={loadingMore} disabled={loadingMore}>
              Load more ({items.length} of {total})
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
