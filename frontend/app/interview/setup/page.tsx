"use client";

import { Check, Mic, Video } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppHeader } from "@/components/common/app-header";
import { ChoiceGroup } from "@/components/interview/choice-group";
import { JobReview, ResumeReview } from "@/components/interview/document-review";
import { FileDrop } from "@/components/interview/file-drop";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/feedback";
import { Input, Label, Textarea } from "@/components/ui/field";
import { ApiError, errorMessage, pingBackend } from "@/lib/api";
import { env } from "@/lib/env";
import { planRecording } from "@/lib/media/recording-budget";
import { cn, formatBytes, newId } from "@/lib/utils";
import { MAX_JD_CHARS, setupSchema, validateJobText } from "@/lib/validation";
import { documentsApi, interviewsApi } from "@/services/interviews";
import type { DocumentOut, Duration, RecordingMode, Rigor, RoleDetection } from "@/types/api";

const STORAGE_KEY = "mi-setup-v1";

const PARSE_STAGES = [
  { after: 0, text: "Uploading" },
  { after: 1500, text: "Extracting the text" },
  { after: 4000, text: "Identifying skills, experience and requirements" },
  { after: 25000, text: "Still working. The server may be waking up, which can take a minute." },
];

function useStagedMessage(active: boolean) {
  const [message, setMessage] = useState(PARSE_STAGES[0]!.text);
  useEffect(() => {
    if (!active) return;
    setMessage(PARSE_STAGES[0]!.text);
    const timers = PARSE_STAGES.slice(1).map((s) => setTimeout(() => setMessage(s.text), s.after));
    return () => timers.forEach(clearTimeout);
  }, [active]);
  return message;
}

function Step({
  n,
  title,
  done,
  locked,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  locked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`step-${n}`} className={cn("relative pl-12", locked && "opacity-55")}>
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-0 grid size-8 place-items-center rounded-full border text-sm font-semibold",
          done ? "border-ink bg-ink text-white" : "border-line-strong bg-surface text-slate",
        )}
      >
        {done ? <Check className="size-4" /> : n}
      </span>
      <h2 id={`step-${n}`} className="pt-0.5 text-2xl font-semibold">
        {title}
        {locked && <span className="sr-only"> (complete the previous step first)</span>}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function failedDocId(e: unknown): string | undefined {
  const id = e instanceof ApiError ? e.details?.document_id : undefined;
  return typeof id === "string" ? id : undefined;
}

interface Saved {
  resume?: DocumentOut | null;
  job?: DocumentOut | null;
}

export default function SetupPage() {
  const router = useRouter();
  const [resume, setResume] = useState<DocumentOut | null>(null);
  const [job, setJob] = useState<DocumentOut | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<{ message: string; docId?: string } | null>(null);
  const [jdMode, setJdMode] = useState<"paste" | "file">("paste");
  const [jdText, setJdText] = useState("");
  const [jdBusy, setJdBusy] = useState(false);
  const [jdError, setJdError] = useState<{ message: string; docId?: string } | null>(null);

  const [roles, setRoles] = useState<RoleDetection | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [customRole, setCustomRole] = useState("");
  const [duration, setDuration] = useState<Duration>(20);
  const [rigor, setRigor] = useState<Rigor>("standard");
  const [recordingMode, setRecordingMode] = useState<RecordingMode>("audio");
  const [consent, setConsent] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [startStage, setStartStage] = useState<"idle" | "creating" | "planning">("idle");
  const [startError, setStartError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const idemKey = useRef<string>(newId());

  const resumeMsg = useStagedMessage(resumeBusy);
  const jdMsg = useStagedMessage(jdBusy);

  // Restore parsed documents after a refresh; wake the backend early.
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Saved;
      if (saved.resume?.parsing_status === "parsed") setResume(saved.resume);
      if (saved.job?.parsing_status === "parsed") setJob(saved.job);
    } catch {
      /* ignore corrupt storage */
    }
    void pingBackend(60_000);
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ resume, job } satisfies Saved));
    } catch {
      /* storage may be unavailable */
    }
  }, [resume, job]);

  // Role detection once the job description is parsed.
  useEffect(() => {
    if (!job || job.parsing_status !== "parsed") {
      setRoles(null);
      return;
    }
    let active = true;
    documentsApi
      .detectRoles(job.id)
      .then((r) => {
        if (!active) return;
        setRoles(r);
        setRole((current) => current ?? r.default_role);
      })
      .catch(() => active && setRoles({ roles: [], default_role: null, needs_user_choice: true }));
    return () => {
      active = false;
    };
  }, [job]);

  const chosenRole = role === "__custom__" ? customRole.trim() : role;
  const plan = useMemo(() => planRecording(recordingMode, duration, env.recordingMaxBytes), [recordingMode, duration]);

  async function uploadResume(file: File) {
    setResumeBusy(true);
    setResumeError(null);
    try {
      setResume(await documentsApi.uploadResume(file));
    } catch (e) {
      setResumeError({ message: errorMessage(e), docId: failedDocId(e) });
    } finally {
      setResumeBusy(false);
    }
  }

  async function retryDoc(kind: "resume" | "job", docId: string) {
    const setBusy = kind === "resume" ? setResumeBusy : setJdBusy;
    const setErr = kind === "resume" ? setResumeError : setJdError;
    setBusy(true);
    setErr(null);
    try {
      const doc = await documentsApi.retryParse(docId);
      if (kind === "resume") setResume(doc);
      else setJob(doc);
    } catch (e) {
      setErr({ message: errorMessage(e), docId });
    } finally {
      setBusy(false);
    }
  }

  async function submitJob(file?: File) {
    if (!file) {
      const problem = validateJobText(jdText);
      if (problem) {
        setJdError({ message: problem });
        return;
      }
    }
    setJdBusy(true);
    setJdError(null);
    try {
      const doc = await documentsApi.uploadJobDescription(file ? { file } : { text: jdText.trim() });
      setJob(doc);
      setRole(null);
    } catch (e) {
      setJdError({ message: errorMessage(e), docId: failedDocId(e) });
    } finally {
      setJdBusy(false);
    }
  }

  async function start() {
    setStartError(null);
    const parsed = setupSchema.safeParse({
      jobRole: chosenRole ?? "",
      duration,
      rigor,
      recordingMode,
      consent,
    });
    const errors: Record<string, string> = {};
    if (!resume || resume.parsing_status !== "parsed") errors.resume = "Upload your resume first.";
    if (!job || job.parsing_status !== "parsed") errors.job = "Add the job description first.";
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors[String(issue.path[0])] = issue.message;
    }
    if (recordingMode !== "none" && !plan.fits) {
      errors.recordingMode = "This recording won't fit the storage limit. Choose audio only or no recording.";
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length || !resume || !job || !chosenRole) return;

    try {
      let id = createdId;
      if (!id) {
        setStartStage("creating");
        const interview = await interviewsApi.create(
          {
            resume_document_id: resume.id,
            job_description_document_id: job.id,
            job_role: chosenRole,
            duration_minutes: duration,
            evaluation_rigor: rigor,
            recording_mode: recordingMode,
            consent_given: true,
          },
          idemKey.current,
        );
        id = interview.id;
        setCreatedId(id);
      }
      setStartStage("planning");
      await interviewsApi.plan(id);
      sessionStorage.removeItem(STORAGE_KEY);
      router.push(`/interview/${id}/live`);
    } catch (e) {
      setStartStage("idle");
      if (e instanceof ApiError && e.code === "PLAN_IN_PROGRESS") {
        setStartError("Your questions are still being prepared. Wait a few seconds and press Start again.");
      } else {
        setStartError(errorMessage(e));
      }
    }
  }

  async function changeSettings() {
    if (createdId) {
      try {
        await interviewsApi.cancel(createdId);
      } catch {
        /* an unstarted interview is harmless if cancel fails */
      }
    }
    setCreatedId(null);
    idemKey.current = newId();
    setStartError(null);
  }

  const resumeDone = resume?.parsing_status === "parsed";
  const jobDone = job?.parsing_status === "parsed";
  const roleDone = Boolean(chosenRole && chosenRole.length >= 2);
  const locked = Boolean(createdId);

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-3xl px-5 pb-24 pt-10 sm:px-8">
        <h1 className="text-4xl font-semibold">Set up your interview</h1>
        <p className="mt-3 text-slate">
          Your resume and the job description shape every question. Nothing is sent to the AI until the file has been
          checked and its text extracted.
        </p>

        <div className="mt-12 space-y-14">
          <Step n={1} title="Your resume" done={resumeDone}>
            {resumeBusy ? (
              <Notice tone="info" title="Reading your resume">
                {resumeMsg}…
              </Notice>
            ) : resumeDone && resume ? (
              <div className="space-y-4">
                <p className="text-sm text-slate">
                  {resume.file_name}. Check what we found and correct anything that&apos;s wrong.
                </p>
                <ResumeReview doc={resume} onUpdated={setResume} />
                <Button variant="link" size="sm" onClick={() => setResume(null)}>
                  Use a different resume
                </Button>
              </div>
            ) : (
              <FileDrop
                label="Choose your resume or drop it here"
                hint="PDF or Word (.docx), up to 5 MB"
                onFile={uploadResume}
              />
            )}
            {resumeError && (
              <Notice
                tone="error"
                className="mt-3"
                title="We couldn't use that resume"
                action={
                  resumeError.docId ? (
                    <Button size="sm" variant="secondary" onClick={() => retryDoc("resume", resumeError.docId!)}>
                      Try again
                    </Button>
                  ) : undefined
                }
              >
                {resumeError.message}
              </Notice>
            )}
            {fieldErrors.resume && (
              <p role="alert" className="mt-2 text-sm text-signal">
                {fieldErrors.resume}
              </p>
            )}
          </Step>

          <Step n={2} title="The job description" done={jobDone}>
            {jdBusy ? (
              <Notice tone="info" title="Reading the job description">
                {jdMsg}…
              </Notice>
            ) : jobDone && job ? (
              <div className="space-y-4">
                <JobReview doc={job} onUpdated={setJob} />
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setJob(null);
                    setRole(null);
                  }}
                >
                  Use a different job description
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div
                  role="tablist"
                  aria-label="Job description input"
                  className="inline-flex rounded-md border border-line-strong bg-surface p-1"
                >
                  {(["paste", "file"] as const).map((m) => (
                    <button
                      key={m}
                      role="tab"
                      type="button"
                      aria-selected={jdMode === m}
                      onClick={() => setJdMode(m)}
                      className={cn(
                        "rounded-sm px-4 py-1.5 text-sm font-medium",
                        jdMode === m ? "bg-ink text-white" : "text-slate hover:text-ink",
                      )}
                    >
                      {m === "paste" ? "Paste text" : "Upload a file"}
                    </button>
                  ))}
                </div>
                {jdMode === "paste" ? (
                  <div className="space-y-2">
                    <Label htmlFor="jd">Job description</Label>
                    <Textarea
                      id="jd"
                      value={jdText}
                      maxLength={MAX_JD_CHARS}
                      onChange={(e) => setJdText(e.target.value)}
                      placeholder="Paste the full posting: responsibilities, requirements and nice-to-haves."
                      className="min-h-48"
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate">{jdText.trim().length.toLocaleString()} characters</span>
                      <Button onClick={() => submitJob()} disabled={!jdText.trim()}>
                        Read job description
                      </Button>
                    </div>
                  </div>
                ) : (
                  <FileDrop
                    label="Choose the job description file"
                    hint="PDF or Word (.docx), up to 5 MB"
                    onFile={(f) => submitJob(f)}
                  />
                )}
              </div>
            )}
            {jdError && (
              <Notice
                tone="error"
                className="mt-3"
                title="We couldn't use that job description"
                action={
                  jdError.docId ? (
                    <Button size="sm" variant="secondary" onClick={() => retryDoc("job", jdError.docId!)}>
                      Try again
                    </Button>
                  ) : undefined
                }
              >
                {jdError.message}
              </Notice>
            )}
            {fieldErrors.job && (
              <p role="alert" className="mt-2 text-sm text-signal">
                {fieldErrors.job}
              </p>
            )}
          </Step>

          <Step n={3} title="The role you're interviewing for" done={roleDone} locked={!jobDone}>
            {!jobDone ? (
              <p className="text-slate">We&apos;ll suggest roles once the job description is read.</p>
            ) : !roles ? (
              <p className="text-slate">Finding the role…</p>
            ) : (
              <div className="space-y-4">
                {roles.needs_user_choice && roles.roles.length > 0 && (
                  <p className="text-sm text-slate">This posting could fit more than one role. Choose the closest.</p>
                )}
                <ChoiceGroup
                  name="role"
                  legend="Role"
                  value={role}
                  onChange={(v) => !locked && setRole(v)}
                  choices={[
                    ...roles.roles.map((r) => ({ value: r.title, label: r.title, description: r.reason || undefined })),
                    { value: "__custom__", label: "Something else", description: "Type the role yourself" },
                  ]}
                  error={fieldErrors.jobRole}
                />
                {role === "__custom__" && (
                  <div className="max-w-md space-y-1.5">
                    <Label htmlFor="custom-role">Role title</Label>
                    <Input
                      id="custom-role"
                      value={customRole}
                      disabled={locked}
                      maxLength={200}
                      onChange={(e) => setCustomRole(e.target.value)}
                      placeholder="e.g. Product Analyst"
                    />
                  </div>
                )}
              </div>
            )}
          </Step>

          <Step n={4} title="Length and pressure" done={roleDone} locked={!roleDone}>
            <div className={cn("space-y-8", locked && "pointer-events-none")}>
              <ChoiceGroup<Duration>
                name="duration"
                legend="Interview length"
                columns={4}
                value={duration}
                onChange={setDuration}
                choices={[10, 20, 30, 45].map((d) => ({ value: d as Duration, label: `${d} minutes` }))}
              />
              <ChoiceGroup<Rigor>
                name="rigor"
                legend="How hard should the interviewer push?"
                value={rigor}
                onChange={setRigor}
                choices={[
                  {
                    value: "standard",
                    label: "Standard",
                    description: "Balanced questions on your experience, core skills and the role.",
                  },
                  {
                    value: "target_bar",
                    label: "Target bar",
                    description: "Deeper questions that check for what's expected at this level.",
                  },
                  {
                    value: "stress_test",
                    label: "Stress test",
                    description: "Ambiguous scenarios and pointed follow-ups, in a professional tone.",
                  },
                ]}
              />
              <p className="text-sm text-slate">All three use the same scoring rubric.</p>
            </div>
          </Step>

          <Step n={5} title="Recording and consent" done={consent} locked={!roleDone}>
            <div className={cn("space-y-6", locked && "pointer-events-none")}>
              <ChoiceGroup<RecordingMode>
                name="recording"
                legend="Save a recording you can replay?"
                columns={3}
                value={recordingMode}
                onChange={setRecordingMode}
                error={fieldErrors.recordingMode}
                choices={[
                  { value: "audio", label: "Audio only", description: "Smallest file." },
                  { value: "video", label: "Video and audio", description: "Uses your camera." },
                  { value: "none", label: "Don't record", description: "Transcript only." },
                ]}
              />
              {recordingMode !== "none" && (
                <Notice tone={plan.fits && plan.quality !== "low" ? "info" : "warning"}>
                  Estimated size about {formatBytes(plan.estimatedBytes)} (limit {formatBytes(env.recordingMaxBytes)}).
                  {recordingMode === "video" &&
                    plan.quality === "reduced" &&
                    " Video will be recorded at reduced quality to fit."}
                  {recordingMode === "video" &&
                    plan.quality === "low" &&
                    " Video quality will be low at this length; audio only is recommended."}
                  {!plan.fits && " This won't fit. Choose audio only or a shorter interview."} Only your latest
                  recording is kept; it replaces the previous one after the new upload is verified.
                </Notice>
              )}
              <div className="space-y-3 rounded-md border border-line bg-surface p-5 text-[15px]">
                <p className="font-medium">Before you start</p>
                <ul className="space-y-2 text-slate">
                  <li className="flex gap-2.5">
                    <Mic className="mt-0.5 size-4 shrink-0 text-ink" aria-hidden />
                    Your browser will ask for the microphone. Your voice is streamed to Google&apos;s Gemini to run the
                    interview and transcribe answers.
                  </li>
                  <li className="flex gap-2.5">
                    <Video className="mt-0.5 size-4 shrink-0 text-ink" aria-hidden />
                    The camera shows a preview for you
                    {recordingMode === "video" ? " and is included in the recording" : ""}. It is never analysed or
                    scored.
                  </li>
                  <li className="flex gap-2.5">
                    <Check className="mt-0.5 size-4 shrink-0 text-ink" aria-hidden />
                    The timer starts when the interviewer connects and keeps running if you refresh.
                  </li>
                </ul>
                <label className="flex cursor-pointer items-start gap-3 pt-2">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    className="mt-1 size-4 accent-[var(--color-ink)]"
                    aria-describedby="consent-error"
                  />
                  <span>
                    I understand and agree to my audio{recordingMode === "video" ? ", video" : ""} and answers being
                    processed and stored for this interview.
                  </span>
                </label>
                {fieldErrors.consent && (
                  <p id="consent-error" role="alert" className="text-sm text-signal">
                    {fieldErrors.consent}
                  </p>
                )}
              </div>
            </div>
          </Step>
        </div>

        <div className="mt-14 space-y-4 border-t border-line pt-8">
          {startError && (
            <Notice
              tone="error"
              title="The interview didn't start"
              action={
                locked ? (
                  <Button variant="link" size="sm" onClick={changeSettings}>
                    Change settings instead
                  </Button>
                ) : undefined
              }
            >
              {startError}
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <Button size="lg" onClick={start} loading={startStage !== "idle"} disabled={startStage !== "idle"}>
              {startStage === "creating"
                ? "Creating your interview"
                : startStage === "planning"
                  ? "Writing your questions"
                  : locked
                    ? "Try again"
                    : "Start interview"}
            </Button>
            {startStage === "planning" && (
              <p className="text-sm text-slate" aria-live="polite">
                Tailoring questions to {chosenRole}. This usually takes 10 to 30 seconds.
              </p>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
