"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { LoadError } from "@/components/common/states";
import { Badge, Skeleton } from "@/components/ui/feedback";
import { api } from "@/lib/api";
import type { AdminGuestSummaryOut, AdminInterviewListOut } from "@/types/api";

function formatIST(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function scoreLabel(score: number | null): string {
  if (score === null) return "—";
  if (score >= 85) return "Excellent";
  if (score >= 70) return "Strong";
  if (score >= 55) return "Competent";
  if (score >= 40) return "Developing";
  return "Needs Improvement";
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate">{hint}</p>}
    </div>
  );
}

/** Free (no sign-in, no payment) 10-minute interviews: volume, results and who signed up after. */
export function GuestsView() {
  const [summary, setSummary] = useState<AdminGuestSummaryOut | null>(null);
  const [list, setList] = useState<AdminInterviewListOut | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [offset, setOffset] = useState(0);
  const [nonce, setNonce] = useState(0);
  const limit = 25;

  useEffect(() => {
    let active = true;
    Promise.all([
      api<AdminGuestSummaryOut>("/admin/guests/summary", { retries: 0 }),
      api<AdminInterviewListOut>(`/admin/interviews?audience=guest&limit=${limit}&offset=${offset}`, {
        retries: 0,
      }),
    ])
      .then(([s, l]) => {
        if (!active) return;
        setSummary(s);
        setList(l);
        setError(null);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      active = false;
    };
  }, [offset, nonce]);

  if (error) return <LoadError error={error} onRetry={() => setNonce((n) => n + 1)} />;
  if (!summary || !list) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const maxLabel = Math.max(1, ...summary.by_label.map((l) => l.count));
  const maxDaily = Math.max(1, ...summary.daily.map((d) => d.interviews));

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Free interviews" value={String(summary.total_interviews)} hint="all time" />
        <Stat
          label="Today"
          value={`${summary.interviews_today} / ${summary.daily_cap}`}
          hint="used of the daily cap"
        />
        <Stat label="Completed" value={String(summary.completed)} hint={`${summary.failed_or_cancelled} failed or cancelled`} />
        <Stat
          label="Average score"
          value={summary.average_score !== null ? `${Math.round(summary.average_score)}` : "—"}
          hint={`${summary.scored} with a report`}
        />
        <Stat label="Signed up after" value={String(summary.converted)} hint="guest → registered" />
        <Stat
          label="Conversion"
          value={summary.conversion_rate !== null ? `${summary.conversion_rate}%` : "—"}
          hint="of free interviews"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface p-5">
          <h3 className="text-sm font-semibold text-ink">Results by score band</h3>
          <div className="mt-4 space-y-3">
            {summary.by_label.map((l) => (
              <div key={l.label} className="flex items-center gap-3 text-sm">
                <span className="w-36 shrink-0 text-slate">{l.label}</span>
                <div className="h-3 flex-1 rounded-sm bg-paper">
                  <div className="h-3 rounded-sm bg-ink" style={{ width: `${(l.count / maxLabel) * 100}%` }} />
                </div>
                <span className="w-8 text-right font-medium text-ink">{l.count}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-line bg-surface p-5">
          <h3 className="text-sm font-semibold text-ink">Last 14 days</h3>
          {summary.daily.length === 0 ? (
            <p className="mt-4 text-sm text-slate">No free interviews in the last 14 days.</p>
          ) : (
            <div className="mt-4 space-y-2">
              {summary.daily.map((d) => (
                <div key={d.date} className="flex items-center gap-3 text-sm">
                  <span className="w-24 shrink-0 text-slate">{d.date.slice(5)}</span>
                  <div className="h-3 flex-1 rounded-sm bg-paper">
                    <div className="h-3 rounded-sm bg-ink" style={{ width: `${(d.interviews / maxDaily) * 100}%` }} />
                  </div>
                  <span className="w-20 text-right text-ink">
                    {d.interviews}
                    {d.converted > 0 && <span className="text-go"> · {d.converted}↑</span>}
                  </span>
                </div>
              ))}
              <p className="pt-1 text-xs text-slate">↑ = signed up afterwards</p>
            </div>
          )}
        </section>
      </div>

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Free interviews ({list.total})</h3>
          <p className="text-xs text-slate">
            Guests who don&apos;t sign up are deleted after 48 hours; their results stay in the numbers above
            {summary.archived > 0 ? ` (${summary.archived} archived)` : ""}.
          </p>
        </div>
        <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-line bg-paper text-xs uppercase tracking-wide text-slate">
              <tr>
                <th className="px-4 py-3 font-medium">When (IST)</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Answered</th>
                <th className="px-4 py-3 font-medium">Result</th>
                <th className="px-4 py-3 font-medium">Signed up</th>
                <th className="px-4 py-3 font-medium">Report</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-slate">
                    No free interviews yet.
                  </td>
                </tr>
              )}
              {list.items.map((i) => (
                <tr key={i.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-slate">{formatIST(i.created_at)}</td>
                  <td className="px-4 py-3 text-ink">{i.job_role}</td>
                  <td className="px-4 py-3">
                    <Badge tone={i.status === "completed" ? "go" : i.status === "failed" ? "signal" : "neutral"}>
                      {i.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-ink">
                    {i.questions_answered} / {i.questions_total}
                  </td>
                  <td className="px-4 py-3 text-ink">
                    {i.overall_score !== null ? `${Math.round(i.overall_score)} · ${scoreLabel(i.overall_score)}` : "—"}
                  </td>
                  <td className="px-4 py-3">{i.converted ? <Badge tone="go">Yes</Badge> : <span className="text-slate">No</span>}</td>
                  <td className="px-4 py-3">
                    {i.overall_score !== null ? (
                      <Link
                        href={`/interview/${i.id}/report?admin=1`}
                        className="font-medium text-ink underline underline-offset-4"
                      >
                        View
                      </Link>
                    ) : (
                      <span className="text-slate">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.total > limit && (
          <div className="mt-3 flex items-center justify-end gap-2 text-sm">
            <button
              type="button"
              className="rounded-md border border-line px-3 py-1.5 disabled:opacity-50"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - limit))}
            >
              Previous
            </button>
            <span className="text-slate">
              {offset + 1}–{Math.min(offset + limit, list.total)} of {list.total}
            </span>
            <button
              type="button"
              className="rounded-md border border-line px-3 py-1.5 disabled:opacity-50"
              disabled={offset + limit >= list.total}
              onClick={() => setOffset((o) => o + limit)}
            >
              Next
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
