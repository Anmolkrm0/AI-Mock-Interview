"use client";

import { Check, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { AppHeader } from "@/components/common/app-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Notice, ProgressBar } from "@/components/ui/feedback";
import { errorMessage } from "@/lib/api";
import { pendingRecordings, type FinishedRecording } from "@/lib/media/recorder";
import { uploadWithProgress } from "@/lib/media/upload";
import { cn, formatBytes, newId } from "@/lib/utils";
import { interviewsApi, recordingsApi } from "@/services/interviews";
import type { StatusOut } from "@/types/api";

type StepState = "waiting" | "active" | "done" | "failed" | "skipped";

function StepRow({ state, title, children }: { state: StepState; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border",
          state === "done" && "border-ink bg-ink text-white",
          state === "active" && "border-ink text-ink",
          state === "failed" && "border-signal bg-signal-soft text-signal",
          (state === "waiting" || state === "skipped") && "border-line-strong text-slate",
        )}
      >
        {state === "done" ? (
          <Check className="size-4" />
        ) : state === "active" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : state === "failed" ? (
          <X className="size-4" />
        ) : null}
      </span>
      <div className="min-w-0 flex-1 pb-6">
        <p className={cn("font-medium", state === "waiting" && "text-slate")}>
          {title}
          <span className="sr-only">: {state}</span>
        </p>
        {children && <div className="mt-1.5 text-[15px] text-slate">{children}</div>}
      </div>
    </li>
  );
}

export default function ProcessingPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [status, setStatus] = useState<StatusOut | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [recording] = useState<FinishedRecording | null>(() => pendingRecordings.get(id));
  const [upload, setUpload] = useState<{ state: StepState; progress: number; error?: string }>(() =>
    pendingRecordings.get(id) ? { state: "active", progress: 0 } : { state: "skipped", progress: 0 },
  );
  const [retrying, setRetrying] = useState(false);
  const uploadStarted = useRef(false);

  const runUpload = useCallback(async () => {
    if (!recording) return;
    setUpload({ state: "active", progress: 0 });
    try {
      const slot = await recordingsApi.uploadUrl({
        interview_id: id,
        mime_type: recording.mimeType,
        size_bytes: recording.blob.size,
        duration_seconds: recording.durationSeconds,
      });
      await uploadWithProgress(slot, recording.blob, recording.mimeType, (p) =>
        setUpload((u) => ({ ...u, progress: p })),
      );
      await recordingsApi.confirm(slot.upload_id);
      pendingRecordings.clear(id);
      setUpload({ state: "done", progress: 1 });
    } catch (e) {
      setUpload({ state: "failed", progress: 0, error: errorMessage(e) });
      void interviewsApi
        .events(id, [
          { client_event_id: newId(), event_type: "metric", metric_name: "recording_upload_failed", metric_value: 1 },
        ])
        .catch(() => undefined);
    }
  }, [id, recording]);

  useEffect(() => {
    if (recording && !uploadStarted.current) {
      uploadStarted.current = true;
      void runUpload();
    }
  }, [recording, runUpload]);

  // Warn before closing while the recording only exists in this tab.
  useEffect(() => {
    if (upload.state !== "active" && upload.state !== "failed") return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [upload.state]);

  // Poll report generation.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const s = await interviewsApi.status(id);
        if (!active) return;
        setStatus(s);
        setStatusError(null);
        if (s.status === "completed" || s.status === "cancelled") return;
        if (s.status === "failed" && s.failure_stage === "evaluation") return;
      } catch (e) {
        if (active) setStatusError(errorMessage(e));
      }
      timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, retrying]);

  const reportReady = status?.status === "completed";
  const uploadSettled = upload.state === "done" || upload.state === "skipped";
  useEffect(() => {
    if (reportReady && uploadSettled) {
      const t = setTimeout(() => router.replace(`/interview/${id}/report`), 900);
      return () => clearTimeout(t);
    }
  }, [reportReady, uploadSettled, id, router]);

  async function retryEvaluation() {
    setRetrying(true);
    try {
      await interviewsApi.retryEvaluation(id);
    } catch (e) {
      setStatusError(errorMessage(e));
    } finally {
      setRetrying(false);
    }
  }

  function skipRecording() {
    pendingRecordings.clear(id);
    setUpload({ state: "skipped", progress: 0 });
  }

  const evalFailed = status?.status === "failed" && status.failure_stage === "evaluation";
  const evalState: StepState = reportReady ? "done" : evalFailed ? "failed" : status ? "active" : "waiting";
  const answered = status?.progress.answered ?? 0;

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl px-5 py-12 sm:px-8">
        <h1 className="text-4xl font-semibold">
          {reportReady ? "Your report is ready" : "Wrapping up your interview"}
        </h1>
        <p className="mt-3 text-slate">
          {reportReady
            ? "Opening it now."
            : "Keep this page open until the recording has uploaded. Scoring usually takes under a minute."}
        </p>

        {status?.status === "cancelled" ? (
          <Notice
            className="mt-8"
            tone="info"
            title="Nothing to score"
            action={
              <Link href="/interview/setup" className="font-medium underline">
                Start a new interview
              </Link>
            }
          >
            The interview ended before any answers were recorded.
          </Notice>
        ) : (
          <ol className="mt-10" aria-live="polite">
            <StepRow state={status ? "done" : "active"} title="Answers saved">
              {status && `${answered} answered, ${status.progress.skipped} skipped.`}
            </StepRow>
            <StepRow
              state={upload.state}
              title={recording ? `Uploading your recording (${formatBytes(recording.blob.size)})` : "Recording"}
            >
              {upload.state === "active" && <ProgressBar value={upload.progress * 100} label="Recording upload" />}
              {upload.state === "skipped" &&
                (recording
                  ? "Not saved. Your transcript and report are unaffected."
                  : "This interview wasn't recorded, or the recording isn't available in this tab.")}
              {upload.state === "done" && "Saved privately. It replaces your previous recording."}
              {recording?.stoppedAtLimit &&
                upload.state !== "skipped" &&
                " The recording reached the size limit, so it covers the interview up to that point."}
              {upload.state === "failed" && (
                <div className="space-y-2">
                  <p className="text-signal">{upload.error} Your previous recording, transcript and report are safe.</p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void runUpload()}>
                      Retry upload
                    </Button>
                    <Button size="sm" variant="ghost" onClick={skipRecording}>
                      Don&apos;t save it
                    </Button>
                  </div>
                </div>
              )}
            </StepRow>
            <StepRow state={evalState} title="Scoring your answers">
              {evalFailed ? (
                <div className="space-y-2">
                  <p className="text-signal">
                    Scoring didn&apos;t finish ({status?.failure_code ?? "error"}). Your transcript is saved.
                  </p>
                  <Button size="sm" onClick={retryEvaluation} loading={retrying}>
                    Try scoring again
                  </Button>
                </div>
              ) : status && !reportReady ? (
                status.evaluation_attempts > 1 ? (
                  "The AI service was busy; retrying automatically."
                ) : (
                  "Checking each answer against the rubric."
                )
              ) : null}
            </StepRow>
          </ol>
        )}

        {statusError && (
          <Notice tone="warning" className="mt-4" title="Can't check progress right now">
            {statusError} We&apos;ll keep trying.
          </Notice>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          {reportReady && (
            <Link href={`/interview/${id}/report`} className={buttonVariants()}>
              Open report
            </Link>
          )}
          <Link href="/dashboard" className={buttonVariants({ variant: "secondary" })}>
            Back to dashboard
          </Link>
        </div>
      </main>
    </>
  );
}
