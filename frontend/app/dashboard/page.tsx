"use client";

import { Disc3, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { LoadError, WakingNotice } from "@/components/common/states";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/feedback";
import { useAsync } from "@/hooks/use-async";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { cn, formatDate, RIGOR_LABELS } from "@/lib/utils";
import { interviewsApi } from "@/services/interviews";
import type { InterviewSummary } from "@/types/api";

function statusBadge(item: InterviewSummary) {
  switch (item.status) {
    case "completed":
      return null;
    case "evaluating":
    case "finalizing":
      return <Badge tone="wait">Report in progress</Badge>;
    case "failed":
      return <Badge tone="signal">Needs attention</Badge>;
    case "in_progress":
    case "paused":
    case "connecting":
      return <Badge tone="ink">In progress</Badge>;
    default:
      return <Badge>Not started</Badge>;
  }
}

function primaryLink(item: InterviewSummary): { href: string; label: string } {
  if (item.status === "completed") return { href: `/interview/${item.id}/report`, label: "View report" };
  if (["evaluating", "finalizing"].includes(item.status) || (item.status === "failed" && item.report_status))
    return { href: `/interview/${item.id}/processing`, label: "Check progress" };
  if (["ready", "connecting", "in_progress", "paused"].includes(item.status))
    return { href: `/interview/${item.id}/live`, label: "Resume" };
  return { href: `/interview/setup`, label: "Set up again" };
}

function ScoreCell({ score }: { score: number | null }) {
  if (score === null) return <span className="text-slate">—</span>;
  return (
    <span className="font-display text-2xl font-semibold tabular-nums">
      {Math.round(score)}
      <span className="text-sm font-normal text-slate">/100</span>
    </span>
  );
}

export default function DashboardPage() {
  const [name, setName] = useState<string | null>(null);
  const { data, error, loading, slow, reload } = useAsync(() => interviewsApi.list(0, 50));

  useEffect(() => {
    getSupabaseBrowser()
      .auth.getUser()
      .then(({ data: u }) => {
        const meta = u.user?.user_metadata as { display_name?: string } | undefined;
        setName(meta?.display_name?.split(" ")[0] ?? null);
      })
      .catch(() => setName(null));
  }, []);

  const items = data?.items ?? [];
  const completed = items.filter((i) => i.overall_score !== null);
  const latest = completed[0];

  return (
    <main id="main" className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="text-4xl font-semibold">{name ? `Welcome back, ${name}` : "Your interviews"}</h1>
          <p className="mt-2 text-slate">
            {latest
              ? `Your most recent score was ${Math.round(latest.overall_score ?? 0)} for ${latest.job_role}.`
              : "Practice for a specific job and track how your answers improve."}
          </p>
        </div>
        <Link href="/interview/setup" className={buttonVariants({ size: "lg" })}>
          <Plus /> Start new interview
        </Link>
      </div>

      <section aria-labelledby="history" className="mt-10">
        <h2 id="history" className="sr-only">
          Interview history
        </h2>
        {slow && loading && <WakingNotice />}
        {error && <LoadError error={error} onRetry={reload} />}
        {loading && (
          <div className="space-y-3" aria-label="Loading interviews">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="rounded-lg border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
            <p className="mx-auto max-w-md font-display text-xl font-semibold">
              No interviews yet. Start your first mock interview to track your progress.
            </p>
            <Link href="/interview/setup" className={cn(buttonVariants(), "mt-6")}>
              Start your first interview
            </Link>
          </div>
        )}
        {!loading && items.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <table className="w-full text-left text-[15px]">
              <thead className="border-b border-line bg-paper text-sm text-slate">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Role
                  </th>
                  <th scope="col" className="hidden px-5 py-3 font-medium sm:table-cell">
                    Date
                  </th>
                  <th scope="col" className="hidden px-5 py-3 font-medium md:table-cell">
                    Format
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Score
                  </th>
                  <th scope="col" className="px-5 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const link = primaryLink(item);
                  return (
                    <tr key={item.id} className="border-b border-line last:border-0">
                      <td className="px-5 py-4 align-middle">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.job_role}</span>
                          {statusBadge(item)}
                          {item.has_current_recording && (
                            <Badge tone="neutral">
                              <Disc3 className="size-3" aria-hidden /> Latest recording
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-sm text-slate sm:hidden">{formatDate(item.created_at)}</p>
                      </td>
                      <td className="hidden px-5 py-4 text-slate sm:table-cell">{formatDate(item.created_at)}</td>
                      <td className="hidden px-5 py-4 text-slate md:table-cell">
                        {item.duration_minutes} min, {RIGOR_LABELS[item.evaluation_rigor]}
                      </td>
                      <td className="px-5 py-4">
                        <ScoreCell score={item.overall_score} />
                      </td>
                      <td className="px-5 py-4 text-right">
                        <Link href={link.href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                          {link.label}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
