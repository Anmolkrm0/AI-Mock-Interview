"use client";

import { AlertTriangle, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AppHeader } from "@/components/common/app-header";
import { LoadError, WakingNotice } from "@/components/common/states";
import { FeedbackForm } from "@/components/report/feedback-form";
import { Button, buttonVariants } from "@/components/ui/button";
import { Notice, Skeleton } from "@/components/ui/feedback";
import { useAsync } from "@/hooks/use-async";
import { ApiError } from "@/lib/api";
import { highlightQuotes } from "@/lib/highlight";
import { cn, formatDate, RIGOR_LABELS } from "@/lib/utils";
import { interviewsApi } from "@/services/interviews";
import type { CompetencyScore, QuestionEvaluation, ReportOut } from "@/types/api";

const SUFFICIENCY: Record<string, { tone: "info" | "warning"; text: string }> = {
  limited: {
    tone: "warning",
    text: "Only a few answers could be scored, so treat the overall score as a rough guide.",
  },
  insufficient: {
    tone: "warning",
    text: "There wasn't enough answered material to produce a reliable score. Answer at least three questions next time.",
  },
};

const REASONS: Record<string, string> = {
  skipped: "Skipped",
  not_answered: "Asked, no answer recorded",
  not_reached: "Not reached in time",
};

function ScoreScale({ value }: { value: number }) {
  return (
    <div className="relative mt-2 h-2 rounded-full bg-line" aria-hidden>
      <div className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: `${value}%` }} />
    </div>
  );
}

function Competencies({ items }: { items: CompetencyScore[] }) {
  return (
    <ul className="space-y-5">
      {items.map((c) => (
        <li key={c.competency}>
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-medium">{c.competency}</span>
            <span className="text-sm tabular-nums text-slate">
              {c.score === null ? "No evidence" : `${Math.round(c.score)} / 100`}
            </span>
          </div>
          {c.score !== null ? (
            <ScoreScale value={c.score} />
          ) : (
            <div className="mt-2 h-2 rounded-full border border-dashed border-line-strong" aria-hidden />
          )}
          <p className="mt-1 text-xs text-slate">
            Weight {Math.round(c.weight * 100)}%, {c.questions_evaluated}{" "}
            {c.questions_evaluated === 1 ? "answer" : "answers"}
          </p>
        </li>
      ))}
    </ul>
  );
}

function QuestionCard({ q }: { q: QuestionEvaluation }) {
  const [open, setOpen] = useState(q.score <= 3);
  const verified = q.evidence.filter((e) => e.verified);
  const unverified = q.evidence.filter((e) => !e.verified);
  const segments = highlightQuotes(
    q.answer_transcript,
    verified.map((e) => e.quote),
  );
  return (
    <article className="rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-6 p-5 text-left sm:p-6"
      >
        <div className="min-w-0">
          <p className="text-sm text-slate">
            Question {q.sequence_number}, {q.competency}
          </p>
          <h3 className="mt-1 font-sans text-lg font-semibold leading-snug tracking-normal">{q.question_text}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <p className="font-display text-2xl font-semibold tabular-nums">
              {q.score}
              <span className="text-sm font-normal text-slate">/5</span>
            </p>
            <p className="text-xs text-slate">{q.rubric_label}</p>
          </div>
          <ChevronDown className={cn("size-5 text-slate transition-transform", open && "rotate-180")} aria-hidden />
        </div>
      </button>
      {open && (
        <div className="space-y-6 border-t border-line p-5 sm:p-6">
          <section>
            <h4 className="text-sm font-semibold">
              Your answer{q.answer_source === "text" ? " (typed)" : ""}
              {q.attempts_total > 1 && (
                <span className="font-normal text-slate">
                  , attempt {q.attempt_number} of {q.attempts_total}
                </span>
              )}
            </h4>
            <blockquote className="mt-2 max-w-prose whitespace-pre-line text-[15px] leading-relaxed">
              {segments.map((s, i) =>
                s.marked ? (
                  <mark key={i} className="mark-evidence text-ink">
                    {s.text}
                  </mark>
                ) : (
                  <span key={i}>{s.text}</span>
                ),
              )}
            </blockquote>
            {verified.length > 0 && (
              <p className="mt-2 text-xs text-slate">
                Highlighted: the lines the score is based on, found word-for-word in your answer.
              </p>
            )}
          </section>

          <section>
            <h4 className="text-sm font-semibold">Why this score</h4>
            <p className="mt-1 max-w-prose text-[15px]">{q.rationale}</p>
            {verified.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-[15px]">
                {verified.map((e) => (
                  <li key={e.quote} className="text-slate">
                    <span className="text-ink">&ldquo;{e.quote}&rdquo;</span> shows{" "}
                    {e.supports.charAt(0).toLowerCase() + e.supports.slice(1)}
                  </li>
                ))}
              </ul>
            )}
            {unverified.length > 0 && (
              <div className="mt-3 flex gap-2 rounded-md bg-mark-soft/60 px-3 py-2 text-sm text-wait">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p>
                  The assessor also cited {unverified.length === 1 ? "a line" : `${unverified.length} lines`} that
                  {unverified.length === 1 ? " doesn't" : " don't"} appear word-for-word in your answer (
                  {unverified.map((e) => `“${e.quote}”`).join(", ")}). Treat {unverified.length === 1 ? "it" : "them"}{" "}
                  as interpretation, not evidence.
                </p>
              </div>
            )}
          </section>

          {q.gaps.length > 0 && (
            <section>
              <h4 className="text-sm font-semibold">What was missing</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-[15px]">
                {q.gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </section>
          )}
          {q.stronger_answer && (
            <section>
              <h4 className="text-sm font-semibold">A stronger answer could</h4>
              <p className="mt-1 max-w-prose text-[15px]">{q.stronger_answer}</p>
            </section>
          )}
          {q.confidence === "low" && (
            <p className="text-sm text-slate">The assessor had low confidence in this score.</p>
          )}
        </div>
      )}
    </article>
  );
}

function Recording({ interviewId }: { interviewId: string }) {
  const [state, setState] = useState<{ url: string; mime: string } | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    try {
      const r = await interviewsApi.recordingUrl(interviewId);
      setState({ url: r.url, mime: r.mime_type });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    } finally {
      setLoading(false);
    }
  }
  if (missing)
    return (
      <p className="text-sm text-slate">
        No recording is stored for this interview. Only your latest recording is kept.
      </p>
    );
  if (!state)
    return (
      <Button variant="secondary" onClick={load} loading={loading}>
        Play recording
      </Button>
    );
  return state.mime.startsWith("video") ? (
    <video src={state.url} controls className="w-full rounded-md bg-ink" />
  ) : (
    <audio src={state.url} controls className="w-full" />
  );
}

export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: report, error, loading, slow, reload } = useAsync<ReportOut>(() => interviewsApi.report(id), [id]);

  useEffect(() => {
    if (report && report.report_status !== "completed") router.replace(`/interview/${id}/processing`);
  }, [report, id, router]);

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
        {loading && (
          <div className="space-y-4">
            {slow && <WakingNotice />}
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}
        {error && (
          <LoadError
            error={
              error instanceof ApiError && error.code === "REPORT_NOT_FOUND"
                ? new Error("This interview doesn't have a report yet.")
                : error
            }
            onRetry={reload}
          />
        )}
        {report && report.report_status === "completed" && (
          <div className="space-y-12">
            <section className="grid gap-8 border-b border-line pb-10 md:grid-cols-[1fr_auto] md:items-end">
              <div>
                <p className="text-slate">
                  {report.job_role}, {report.duration_minutes} minutes, {RIGOR_LABELS[report.evaluation_rigor]},{" "}
                  {formatDate(report.created_at)}
                </p>
                <h1 className="mt-2 text-4xl font-semibold sm:text-5xl">Interview report</h1>
                {report.summary && <p className="mt-4 max-w-2xl text-lg text-slate">{report.summary}</p>}
              </div>
              <div className="md:text-right">
                {report.overall_score !== null ? (
                  <>
                    <p className="font-display text-7xl font-semibold leading-none tabular-nums">
                      {Math.round(report.overall_score)}
                    </p>
                    <p className="mt-1 text-slate">out of 100, weighted by competency</p>
                  </>
                ) : (
                  <p className="font-display text-2xl font-semibold">Not scored</p>
                )}
              </div>
            </section>

            {report.evidence_sufficiency && SUFFICIENCY[report.evidence_sufficiency] && (
              <Notice tone={SUFFICIENCY[report.evidence_sufficiency]!.tone}>
                {SUFFICIENCY[report.evidence_sufficiency]!.text}
              </Notice>
            )}

            <section className="grid gap-10 md:grid-cols-2">
              <div>
                <h2 className="text-2xl font-semibold">Competencies</h2>
                <div className="mt-6">
                  <Competencies items={report.competency_scores} />
                </div>
              </div>
              <div className="space-y-8">
                {report.strengths.length > 0 && (
                  <div>
                    <h2 className="text-2xl font-semibold">What went well</h2>
                    <ul className="mt-3 list-disc space-y-1.5 pl-5">
                      {report.strengths.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.improvement_areas.length > 0 && (
                  <div>
                    <h2 className="text-2xl font-semibold">What to work on</h2>
                    <ul className="mt-3 list-disc space-y-1.5 pl-5">
                      {report.improvement_areas.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>

            {report.recommendations.length > 0 && (
              <section className="rounded-lg bg-ink p-6 text-white sm:p-8">
                <h2 className="text-2xl font-semibold">Before your next interview</h2>
                <ol className="mt-4 list-decimal space-y-2 pl-5 text-white/85">
                  {report.recommendations.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ol>
              </section>
            )}

            <section>
              <h2 className="text-2xl font-semibold">Answer by answer</h2>
              <p className="mt-2 text-slate">
                Scored 1 to 5:{" "}
                {Object.entries(report.rubric)
                  .map(([k, v]) => `${k} ${v.toLowerCase()}`)
                  .join("; ")}
                .
              </p>
              <div className="mt-6 space-y-4">
                {report.question_evaluations.map((q) => (
                  <QuestionCard key={q.question_id} q={q} />
                ))}
              </div>
              {report.unevaluated_questions.length > 0 && (
                <div className="mt-8">
                  <h3 className="text-lg font-semibold">Not scored</h3>
                  <p className="mt-1 text-sm text-slate">These don&apos;t count toward your score.</p>
                  <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-surface">
                    {report.unevaluated_questions.map((u) => (
                      <li key={u.question_id} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
                        <span>{u.question_text}</span>
                        <span className="text-sm text-slate">{REASONS[u.reason] ?? u.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section className="grid gap-10 border-t border-line pt-10 md:grid-cols-2">
              <div>
                <h2 className="text-2xl font-semibold">Recording</h2>
                <div className="mt-4">
                  <Recording interviewId={id} />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-semibold">Was this useful?</h2>
                <div className="mt-4">
                  <FeedbackForm interviewId={id} initial={report.feedback} />
                </div>
              </div>
            </section>

            <div className="flex flex-wrap gap-3">
              <Link href="/interview/setup" className={buttonVariants()}>
                Practise again
              </Link>
              <Link href="/dashboard" className={buttonVariants({ variant: "secondary" })}>
                All interviews
              </Link>
            </div>
          </div>
        )}
        {report && report.report_status !== "completed" && (
          <Notice tone="info">The report is still being generated. Taking you to its progress page…</Notice>
        )}
      </main>
    </>
  );
}
