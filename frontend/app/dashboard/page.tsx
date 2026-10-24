"use client";

import { Disc3, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { toast } from "sonner";

import { LoadError, WakingNotice } from "@/components/common/states";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Badge, Skeleton } from "@/components/ui/feedback";
import { useAsync } from "@/hooks/use-async";
import { errorMessage } from "@/lib/api";
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

function ScoreCell({ item, onRetry }: { item: InterviewSummary; onRetry?: () => void }) {
  const [retrying, setRetrying] = useState(false);

  if (item.overall_score !== null) {
    return (
      <span className="font-display text-2xl font-semibold tabular-nums">
        {Math.round(item.overall_score)}
        <span className="text-sm font-normal text-slate">/100</span>
      </span>
    );
  }

  const isFailed = item.report_status === "failed" || item.failure_stage === "evaluation";
  if (isFailed) {
    const handleRetry = async () => {
      try {
        setRetrying(true);
        await interviewsApi.retryEvaluation(item.id);
        toast.success("Retrying evaluation…");
        onRetry?.();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setRetrying(false);
      }
    };

    return (
      <span className="inline-flex items-center gap-1 text-sm text-signal">
        Report failed —{" "}
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
          className="font-medium underline hover:text-ink disabled:opacity-50"
        >
          {retrying ? "retrying…" : "retry"}
        </button>
      </span>
    );
  }

  if (
    item.evidence_sufficiency === "insufficient" ||
    (item.report_status === "completed" && item.overall_score === null)
  ) {
    return <span className="text-sm text-slate">Not enough answers to score</span>;
  }

  if (
    item.report_status === "pending" ||
    item.status === "evaluating" ||
    item.status === "finalizing" ||
    (item.status === "completed" && !item.report_status)
  ) {
    return <span className="text-sm text-slate">Report processing</span>;
  }

  return <span className="text-slate">—</span>;
}

export default function DashboardPage() {
  const [name, setName] = useState<string | null>(null);
  const { data, error, loading, slow, reload } = useAsync(() => interviewsApi.list(0, 50));
  const [deleteTarget, setDeleteTarget] = useState<InterviewSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    getSupabaseBrowser()
      .auth.getUser()
      .then(({ data: u }) => {
        const meta = u.user?.user_metadata as { display_name?: string } | undefined;
        setName(meta?.display_name?.split(" ")[0] ?? null);
      })
      .catch(() => setName(null));
  }, []);

  async function handleDeleteInterview() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await interviewsApi.delete(deleteTarget.id);
      toast.success("Interview deleted.");
      setDeleteTarget(null);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  }

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
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
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
                        <ScoreCell item={item} onRetry={reload} />
                      </td>
                      <td className="px-5 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link href={link.href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                            {link.label}
                          </Link>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteTarget(item)}
                            className="text-slate hover:text-signal"
                            aria-label={`Delete interview for ${item.job_role}`}
                            title="Delete interview"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteInterview}
        loading={deleting}
        title="Delete this interview?"
        description="This permanently deletes the transcript, report and any recording."
        confirmLabel="Delete interview"
      />
    </main>
  );
}
