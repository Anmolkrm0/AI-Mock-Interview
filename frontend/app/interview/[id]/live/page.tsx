"use client";

import { Headphones, PhoneOff, VideoOff } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { PhoneNotice } from "@/components/common/phone-notice";
import { Wordmark } from "@/components/common/site-header-client";
import { LoadError, WakingNotice } from "@/components/common/states";
import {
  ConnectionStatus,
  Controls,
  Countdown,
  InterviewerPresence,
  MicMeter,
  QuestionPanel,
  Transcript,
  TypedAnswer,
} from "@/components/interview/live-parts";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Notice, Skeleton } from "@/components/ui/feedback";
import { useAsync } from "@/hooks/use-async";
import { env } from "@/lib/env";
import { preloadAudioWorklet } from "@/lib/live/audio";
import { InterviewConductor, type Snapshot } from "@/lib/live/interview-conductor";
import { InterviewRecorder, pendingRecordings } from "@/lib/media/recorder";
import { planRecording } from "@/lib/media/recording-budget";
import { formatBytes } from "@/lib/utils";
import { interviewsApi, prefetchLiveToken } from "@/services/interviews";
import type { InterviewDetail, LiveTokenOut } from "@/types/api";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

type MediaProblem = { title: string; message: string } | null;

function describeMediaError(error: unknown, kind: "microphone" | "camera"): { title: string; message: string } {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      title: `${kind === "microphone" ? "Microphone" : "Camera"} access is blocked`,
      message: `Allow ${kind} access for this site in your browser's address bar (the lock or camera icon), then try again.`,
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return { title: `No ${kind} found`, message: `Connect a ${kind} and try again.` };
  }
  if (name === "NotReadableError") {
    return {
      title: `The ${kind} is in use`,
      message: `Close other apps using the ${kind} (Zoom, Meet, FaceTime) and try again.`,
    };
  }
  return { title: `The ${kind} couldn't start`, message: "Reload the page and try again." };
}

const FINISHED = new Set(["finalizing", "evaluating", "completed"]);

export default function LivePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: detail, error, loading, slow, reload } = useAsync(() => interviewsApi.get(id), [id]);

  useEffect(() => {
    if (!detail) return;
    if (FINISHED.has(detail.status) || (detail.status === "failed" && detail.failure_stage === "evaluation")) {
      router.replace(`/interview/${id}/processing`);
    }
  }, [detail, id, router]);

  if (loading) {
    return (
      <Shell>
        {slow && <WakingNotice />}
        <Skeleton className="mt-6 h-72 w-full" />
      </Shell>
    );
  }
  if (error || !detail) {
    return (
      <Shell>
        <LoadError error={error ?? new Error("Interview not found.")} onRetry={reload} />
      </Shell>
    );
  }
  if (detail.status === "cancelled") {
    return (
      <Shell>
        <Notice
          tone="info"
          title="This interview was cancelled"
          action={
            <Link className="font-medium underline" href="/interview/setup">
              Set up a new interview
            </Link>
          }
        >
          It ended before any answers were recorded.
        </Notice>
      </Shell>
    );
  }
  if (
    detail.status === "created" ||
    detail.status === "preparing" ||
    (detail.status === "failed" && detail.failure_stage === "planning")
  ) {
    return (
      <Shell>
        <Notice
          tone="warning"
          title="This interview isn't ready yet"
          action={
            <Link className="font-medium underline" href="/interview/setup">
              Go back to setup
            </Link>
          }
        >
          The questions haven&apos;t been prepared.
        </Notice>
      </Shell>
    );
  }
  if (FINISHED.has(detail.status))
    return (
      <Shell>
        <Skeleton className="h-40 w-full" />
      </Shell>
    );
  return <InterviewRoom detail={detail} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl items-center px-5 py-3.5 sm:px-8">
          <Wordmark href="/dashboard" />
        </div>
      </header>
      <main id="main" className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
        {children}
      </main>
    </div>
  );
}

const EMPTY_SNAPSHOT: Snapshot = {
  phase: "idle",
  error: null,
  questions: [],
  currentIndex: null,
  transcript: [],
  partial: null,
  interviewerSpeaking: false,
  hasGreetingStarted: false,
  micLevel: 0,
  inputMode: "voice",
  headphones: false,
  deadlineMs: null,
  clockOffsetMs: 0,
  currentHasAnswer: false,
  notice: null,
};

function InterviewRoom({ detail }: { detail: InterviewDetail }) {
  const router = useRouter();

  // Pre-fetch live token in background as soon as interview detail is available
  useEffect(() => {
    if (detail?.id) {
      prefetchLiveToken(detail.id);
    }
  }, [detail?.id]);

  const conductorRef = useRef<InterviewConductor | null>(null);
  const recorderRef = useRef<InterviewRecorder | null>(null);
  const streamsRef = useRef<{ mic: MediaStream | null; camera: MediaStream | null; ctx: AudioContext | null }>({
    mic: null,
    camera: null,
    ctx: null,
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [mediaProblem, setMediaProblem] = useState<MediaProblem>(null);
  const [micUnavailable, setMicUnavailable] = useState(false);
  const [typedFallbackActive, setTypedFallbackActive] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [headphones, setHeadphones] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [recordingBytes, setRecordingBytes] = useState(0);
  const [recordingActive, setRecordingActive] = useState(false);
  const [conductor, setConductor] = useState<InterviewConductor | null>(null);
  const [recordingStopped, setRecordingStopped] = useState(false);
  const resumed = Boolean(detail.started_at);
  const recordingPlan = planRecording(detail.recording_mode, detail.duration_minutes, env.recordingMaxBytes);

  const subscribe = useCallback((cb: () => void) => conductor?.subscribe(cb) ?? (() => {}), [conductor]);
  const getSnap = useCallback(() => conductor?.getSnapshot() ?? EMPTY_SNAPSHOT, [conductor]);
  const snap = useSyncExternalStore(subscribe, getSnap, () => EMPTY_SNAPSHOT);
  const getRemaining = useCallback(() => conductor?.remainingSeconds() ?? null, [conductor]);

  const releaseMedia = useCallback(() => {
    const { mic, camera, ctx } = streamsRef.current;
    mic?.getTracks().forEach((t) => t.stop());
    camera?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
    streamsRef.current = { mic: null, camera: null, ctx: null };
  }, []);

  // Release devices if the user navigates away mid-interview.
  useEffect(() => {
    return () => {
      conductorRef.current?.dispose();
      void recorderRef.current?.stop();
      releaseMedia();
    };
  }, [releaseMedia]);

  // Warn before closing the tab during a live interview.
  useEffect(() => {
    if (!joined || snap.phase === "ended") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [joined, snap.phase]);

  // Resume audio after the tab was in the background.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void streamsRef.current.ctx?.resume();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  async function join(startClickedAt: number) {
    setJoining(true);
    setMediaProblem(null);
    setMicUnavailable(false);
    let ctx: AudioContext | null = null;
    let mic: MediaStream | null = null;

    try {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setMicUnavailable(true);
        return;
      }
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) {
        setMediaProblem({
          title: "Audio processing is not supported",
          message:
            "Your browser lacks AudioContext support required for real-time speech. We recommend using Chrome on a laptop.",
        });
        return;
      }

      ctx = new AudioCtx();
      if (!ctx.audioWorklet) {
        setMediaProblem({
          title: "Audio processing is not supported",
          message:
            "Your browser lacks AudioWorklet support required for real-time speech. We recommend using Chrome on a laptop.",
        });
        void ctx.close();
        return;
      }

      // Run mic permission, AudioContext + worklet loading, and token fetch in parallel
      let micError: unknown = null;
      const micPromise = withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        }),
        12_000,
        "Microphone prompt timed out.",
      ).catch((err) => {
        micError = err;
        return null;
      });

      const audioPromise = Promise.all([
        ctx.resume(),
        withTimeout(preloadAudioWorklet(ctx), 10_000, "AudioWorklet load timed out."),
      ]).then(() => ctx);

      const tokenPromise = withTimeout(
        interviewsApi.liveToken(detail.id),
        25_000,
        "Token fetch timed out.",
      );

      let token: LiveTokenOut;
      try {
        [mic, , token] = await Promise.all([micPromise, audioPromise, tokenPromise]);
      } catch {
        if (ctx) void ctx.close();
        if (micError) {
          setMicUnavailable(true);
          return;
        }
        setMediaProblem({
          title: "Couldn't connect to the interviewer",
          message: "Couldn't connect to the interviewer. Check your mic permission and try again.",
        });
        return;
      }

      if (micError || !mic) {
        if (ctx) void ctx.close();
        setMicUnavailable(true);
        return;
      }

      streamsRef.current = { mic, camera: null, ctx };

      const engine = new InterviewConductor({ detail, ctx, mic, token, startClickedAt });
      engine.recordPhase("mic permission granted");
      engine.recordPhase("AudioContext/worklet ready");
      engine.recordPhase("live token received");
      engine.setHeadphones(headphones);
      engine.onFinished = (reason) => void wrapUp(reason);
      conductorRef.current = engine;
      setConductor(engine);
      setJoined(true);

      // Connect and start interview with 15s timeout
      await withTimeout(engine.start(), 15_000, "Live session connect timed out.");

      // In background: handle camera if video mode is configured
      if (detail.recording_mode === "video") {
        navigator.mediaDevices
          .getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 } },
          })
          .then((camera) => {
            streamsRef.current.camera = camera;
            setCameraOn(true);
            if (videoRef.current) videoRef.current.srcObject = camera;
          })
          .catch((e) => {
            const p = describeMediaError(e, "camera");
            toast.warning(`${p.title}. The interview continues; the recording will be audio only.`);
          });
      }

      // In background: start media recorder once engine is up
      const plan = recordingPlan;
      if (plan.mode !== "none") {
        const recorder = new InterviewRecorder(plan, env.recordingMaxBytes, setRecordingBytes, () => {
          setRecordingStopped(true);
          toast.warning(
            "Recording stopped at the storage limit. The interview continues and everything up to now is kept.",
          );
        });
        if (recorder.supported) {
          recorder.start(ctx, mic, engine.player.recordTap.stream, streamsRef.current.camera);
          recorderRef.current = recorder;
          setRecordingActive(true);
        } else {
          toast.warning("This browser can't record. The interview continues without a recording.");
        }
      }
    } catch {
      releaseMedia();
      setJoined(false);
      setConductor(null);
      conductorRef.current = null;
      setMediaProblem({
        title: "Couldn't connect to the interviewer",
        message: "Couldn't connect to the interviewer. Check your mic permission and try again.",
      });
    } finally {
      setJoining(false);
    }
  }

  async function joinTyped(startClickedAt: number) {
    setJoining(true);
    setMediaProblem(null);
    let ctx: AudioContext | null = null;

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        ctx = new AudioCtx();
        if (ctx.audioWorklet) {
          await Promise.all([
            ctx.resume(),
            withTimeout(preloadAudioWorklet(ctx), 10_000, "AudioWorklet load timed out."),
          ]).catch(() => undefined);
        }
      }

      const token = await withTimeout(
        interviewsApi.liveToken(detail.id),
        25_000,
        "Token fetch timed out.",
      );

      streamsRef.current = { mic: null, camera: null, ctx };
      setTypedFallbackActive(true);

      const engine = new InterviewConductor({
        detail,
        ctx: ctx || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)(),
        mic: null,
        token,
        startClickedAt,
        initialInputMode: "text",
      });
      engine.recordPhase("AudioContext/worklet ready");
      engine.recordPhase("live token received");
      engine.setHeadphones(headphones);
      engine.onFinished = (reason) => void wrapUp(reason);
      conductorRef.current = engine;
      setConductor(engine);
      setJoined(true);

      // Connect and start interview with 15s timeout
      await withTimeout(engine.start(), 15_000, "Live session connect timed out.");

      toast.info("Microphone unavailable. Recording is skipped; you can answer by typing.", {
        duration: 6000,
      });
    } catch (e) {
      releaseMedia();
      setJoined(false);
      setConductor(null);
      conductorRef.current = null;
      setTypedFallbackActive(false);
      setMediaProblem({
        title: "Couldn't connect to the interviewer",
        message: e instanceof Error ? e.message : "Couldn't connect to the interviewer. Please try again.",
      });
    } finally {
      setJoining(false);
    }
  }

  useEffect(() => {
    if (joined && videoRef.current && streamsRef.current.camera) videoRef.current.srcObject = streamsRef.current.camera;
  }, [joined, cameraOn]);

  async function wrapUp(reason: string) {
    const rec = await recorderRef.current?.stop();
    recorderRef.current = null;
    if (rec) pendingRecordings.set(detail.id, rec);
    releaseMedia();
    if (reason === "time_expired") toast.info("Time's up. Your interview has been saved.");
    router.push(`/interview/${detail.id}/processing`);
  }

  async function endInterview() {
    setConfirmEnd(false);
    if (conductorRef.current) await conductorRef.current.finish("user_ended");
    else {
      await interviewsApi.complete(detail.id, "user_ended").catch(() => undefined);
      router.push(`/interview/${detail.id}/processing`);
    }
  }

  const live = snap.phase === "live";
  const current = snap.currentIndex !== null ? snap.questions[snap.currentIndex] : undefined;
  const canSkip = Boolean(current && current.status !== "answered");
  const canRetake = Boolean(current && (snap.currentHasAnswer || current.status === "answered"));

  if (!joined) {
    return (
      <Shell>
        <PhoneNotice className="mb-6" />
        <h1 className="text-4xl font-semibold">{resumed ? "Rejoin your interview" : "Ready when you are"}</h1>
        <p className="mt-3 text-slate">
          {detail.job_role}, {detail.duration_minutes} minutes.{" "}
          {resumed
            ? "Your timer kept running while you were away, and your earlier answers are saved."
            : "The timer starts when the interviewer connects."}
        </p>
        <div className="mt-8 space-y-5 rounded-lg border border-line bg-surface p-6">
          <ul className="space-y-3 text-[15px]">
            <li>Find a quiet place. Answer out loud as you would in a real interview.</li>
            <li>You can type an answer, skip a question, or retake an answer at any time.</li>
            <li>
              Follow-ups count: if the interviewer asks a follow-up, your response directly enriches your answer and counts toward your final evaluation.
            </li>
            <li>
              {detail.recording_mode === "none"
                ? "This interview isn't recorded; the transcript is saved."
                : `A ${detail.recording_mode === "video" ? "video" : "audio"} recording is saved (about ${formatBytes(recordingPlan.estimatedBytes)} at most). Only your latest recording is kept.`}
            </li>
          </ul>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line p-4">
            <input
              type="checkbox"
              checked={headphones}
              onChange={(e) => setHeadphones(e.target.checked)}
              className="mt-1 size-4 accent-[var(--color-ink)]"
            />
            <span>
              <span className="flex items-center gap-2 font-medium">
                <Headphones className="size-4" aria-hidden /> I&apos;m using headphones
              </span>
              <span className="text-sm text-slate">
                With headphones you can interrupt the interviewer. Without them, your mic pauses while the interviewer
                speaks so it doesn&apos;t hear itself.
              </span>
            </span>
          </label>
          {micUnavailable ? (
            <div className="space-y-4">
              <Notice tone="warning" title="We couldn't use your microphone">
                We couldn&apos;t use your microphone. You can still do the interview by typing your answers.
              </Notice>
              <div className="flex flex-wrap gap-3">
                <Button size="lg" onClick={() => void joinTyped(performance.now())} loading={joining}>
                  Continue with typing
                </Button>
                <Button size="lg" variant="secondary" onClick={() => void join(performance.now())} disabled={joining}>
                  Try microphone again
                </Button>
              </div>
            </div>
          ) : (
            <>
              {mediaProblem && (
                <Notice tone="error" title={mediaProblem.title}>
                  {mediaProblem.message}
                </Notice>
              )}
              <Button size="lg" onClick={() => void join(performance.now())} loading={joining}>
                {mediaProblem ? "Try again" : resumed ? "Rejoin interview" : "Join interview"}
              </Button>
            </>
          )}
          <p className="text-sm text-slate">
            Your browser will ask for microphone{detail.recording_mode === "video" ? " and camera" : ""} access.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3 sm:px-8">
          <div className="min-w-0">
            <p className="truncate font-display text-lg font-semibold">{detail.job_role}</p>
            <ConnectionStatus phase={snap.phase} ready={snap.hasGreetingStarted || resumed} />
          </div>
          <div className="flex items-center gap-5">
            <Countdown getRemaining={getRemaining} />
            <Button
              variant="danger"
              onClick={() => setConfirmEnd(true)}
              disabled={snap.phase === "ending" || snap.phase === "ended"}
            >
              <PhoneOff /> End interview
            </Button>
          </div>
        </div>
      </header>

      <main
        id="main"
        className="mx-auto grid w-full max-w-7xl flex-1 gap-6 px-5 py-6 sm:px-8 lg:grid-cols-[1.35fr_1fr]"
      >
        <section aria-label="Interview" className="flex flex-col gap-6">
          {snap.error && (
            <Notice
              tone="error"
              title={snap.error.title}
              action={
                snap.error.retryable ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void conductor?.retry()}>
                      {snap.error.title.includes("taking too long") ? "Try again" : "Reconnect"}
                    </Button>
                    {snap.error.canTypeFallback && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setTypedFallbackActive(true);
                          void conductor?.continueByTyping();
                        }}
                      >
                        Continue by typing
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" onClick={() => setConfirmEnd(true)}>
                      End and get report
                    </Button>
                  </div>
                ) : (
                  <Link className={buttonVariants({ size: "sm", variant: "secondary" })} href="/dashboard">
                    Go to dashboard
                  </Link>
                )
              }
            >
              {snap.error.message}
            </Notice>
          )}
          {snap.notice && !snap.error && <Notice tone="info">{snap.notice}</Notice>}
          {typedFallbackActive && !snap.error && (
            <Notice tone="info">
              Microphone unavailable: recording is skipped. You can type your answers and your transcript is saved.
            </Notice>
          )}

          <div className="rounded-lg border border-line bg-surface p-6 sm:p-8">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
              <InterviewerPresence
                speaking={snap.interviewerSpeaking}
                listening={live && snap.hasGreetingStarted && snap.inputMode === "voice"}
                connecting={(snap.phase === "connecting" || (!snap.hasGreetingStarted && !resumed)) && !snap.interviewerSpeaking}
              />
              <MicMeter
                level={snap.micLevel}
                muted={
                  snap.inputMode === "text" ||
                  (!snap.hasGreetingStarted && !resumed) ||
                  (!snap.headphones && snap.interviewerSpeaking)
                }
              />
            </div>
            <QuestionPanel
              questions={snap.questions}
              currentIndex={snap.currentIndex}
              isConnecting={!snap.hasGreetingStarted && !resumed}
            />
          </div>

          <div className="space-y-4">
            <Controls
              disabled={!live}
              inputMode={snap.inputMode}
              canSkip={canSkip}
              canRetake={canRetake}
              onToggleText={() => {
                if (!streamsRef.current.mic && snap.inputMode === "text") {
                  toast.warning("Microphone is unavailable for this session. Please type your answers.");
                  return;
                }
                conductor?.setInputMode(snap.inputMode === "text" ? "voice" : "text");
              }}
              onSkip={() => conductor?.skipCurrent()}
              onRetake={() => conductor?.retakeCurrent()}
            />
            {snap.inputMode === "text" && (
              <TypedAnswer disabled={!live} onSubmit={(t) => conductor?.submitTypedAnswer(t) ?? false} />
            )}
          </div>
        </section>

        <aside className="flex min-h-[24rem] flex-col gap-4 lg:max-h-[calc(100dvh-8rem)]">
          <div className="relative aspect-video overflow-hidden rounded-lg bg-ink">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="size-full -scale-x-100 object-cover"
              aria-label="Your camera preview"
            />
            {!cameraOn && (
              <div className="absolute inset-0 grid place-items-center text-sm text-white/70">
                <span className="flex items-center gap-2">
                  <VideoOff className="size-4" aria-hidden /> Camera off
                </span>
              </div>
            )}
            {recordingActive && (
              <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white">
                <span
                  className={
                    recordingStopped
                      ? "size-2 rounded-full bg-white/60"
                      : "size-2 animate-pulse rounded-full bg-[#ff5a4f]"
                  }
                  aria-hidden
                />
                {recordingStopped ? "Recording stopped" : `Recording, ${formatBytes(recordingBytes)}`}
              </span>
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface p-5">
            <h2 className="mb-3 text-sm font-semibold">Transcript</h2>
            <div className="min-h-0 flex-1">
              <Transcript lines={snap.transcript} partial={snap.partial} />
            </div>
          </div>
        </aside>
      </main>

      <ConfirmDialog
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        onConfirm={endInterview}
        title="End the interview now?"
        description="Your answers so far are saved and scored. Questions you didn't reach are listed in the report but don't count against you."
        confirmLabel="End and get report"
        loading={snap.phase === "ending"}
      />
    </div>
  );
}
