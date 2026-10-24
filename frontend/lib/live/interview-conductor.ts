"use client";

import { GoogleGenAI, type LiveConnectConfig, type LiveServerMessage, type Session } from "@google/genai";

import { ApiError, errorMessage } from "@/lib/api";
import { MicCapture, parseSampleRate, PcmPlayer } from "@/lib/live/audio";
import { EventQueue } from "@/lib/live/event-queue";
import { newId } from "@/lib/utils";
import { interviewsApi } from "@/services/interviews";
import type { InterviewDetail, InterviewEvent, LiveTokenOut, QuestionOut, TranscriptLine } from "@/types/api";

/**
 * Client-side interview engine.
 *
 * Responsibilities:
 * - Connect the browser directly to Gemini Live using a short-lived token
 *   minted by our backend (the API key never reaches the browser).
 * - Stream microphone PCM in, play the interviewer's audio out.
 * - Track which planned question is active and collect the candidate's answer
 *   (including follow-up exchanges) for that question.
 * - Execute the interviewer's tool calls (advance_to_question, end_interview).
 * - Apply candidate controls: skip, retake, typed answers, end.
 * - Persist every state change to the backend through a durable event queue.
 * - Recover from dropped connections with a fresh token and session resumption.
 *
 * The backend is the source of truth for status, deadline and answers.
 */

export type Phase = "idle" | "connecting" | "live" | "reconnecting" | "ending" | "ended" | "error";

export interface LiveError {
  title: string;
  message: string;
  retryable: boolean;
}

export interface Snapshot {
  phase: Phase;
  error: LiveError | null;
  questions: QuestionOut[];
  currentIndex: number | null;
  transcript: TranscriptLine[];
  partial: { speaker: "interviewer" | "candidate"; text: string } | null;
  interviewerSpeaking: boolean;
  hasGreetingStarted: boolean;
  micLevel: number;
  inputMode: "voice" | "text";
  headphones: boolean;
  deadlineMs: number | null;
  clockOffsetMs: number;
  currentHasAnswer: boolean;
  notice: string | null;
}

interface AnswerBuffer {
  questionId: string;
  exchange: { speaker: "interviewer" | "candidate"; text: string }[];
  candidateText: string[];
  typed: boolean;
  voiced: boolean;
}

const CONTROL = "[CONTROL]";
const MAX_RECONNECTS = 6;

export interface ConductorDeps {
  detail: InterviewDetail;
  ctx: AudioContext;
  mic: MediaStream;
  token?: LiveTokenOut | Promise<LiveTokenOut>;
  startClickedAt?: number;
}

export class InterviewConductor {
  private snapshot: Snapshot;
  private listeners = new Set<() => void>();
  private readonly queue: EventQueue;
  private session: Session | null = null;
  private capture: MicCapture | null = null;
  readonly player: PcmPlayer;
  private buffer: AnswerBuffer | null = null;
  private interviewerPartial = "";
  private candidatePartial = "";
  private resumptionHandle: string | null = null;
  private closingIntentionally = false;
  private reconnectAttempts = 0;
  private startedSession = false;
  private connectStartedAt = 0;
  private firstAudioReported = false;
  private turnStartedAt = 0;
  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private warnedTwoMinutes = false;
  private finishing: Promise<void> | null = null;
  /** Incremented per connection so close events from replaced sockets are ignored. */
  private generation = 0;
  private phaseTimings: Record<string, number> = {};
  private startClickedAt: number;
  private kickoffSent = false;
  private isReconnectSession = false;
  private isResumedInterview = false;
  onFinished?: (reason: string) => void;

  constructor(private readonly deps: ConductorDeps) {
    const { detail } = deps;
    this.startClickedAt = deps.startClickedAt ?? performance.now();
    this.phaseTimings["start clicked"] = this.startClickedAt;
    console.info("[TTFR] start clicked: 0ms");
    this.queue = new EventQueue(detail.id);
    this.queue.onResult = (r) => {
      if (r.remaining_seconds !== null && r.remaining_seconds !== undefined && this.snapshot.deadlineMs === null) {
        this.setDeadline(Date.now() + r.remaining_seconds * 1000, 0);
      }
    };
    this.queue.onDropped = (_event, error) => {
      if (error.code === "INTERVIEW_TIME_EXPIRED") void this.finish("time_expired");
    };
    this.player = new PcmPlayer(deps.ctx, (speaking) => this.update({ interviewerSpeaking: speaking }));
    try {
      this.resumptionHandle = sessionStorage.getItem(`mi-resume-${detail.id}`);
    } catch {
      this.resumptionHandle = null;
    }
    const offset = Date.parse(detail.server_time) - Date.now();
    this.isResumedInterview =
      Boolean(detail.started_at) || detail.questions.some((q) => q.status !== "pending");
    this.snapshot = {
      phase: "idle",
      error: null,
      questions: detail.questions,
      currentIndex: null,
      transcript: detail.transcript.filter((t) => t.text),
      partial: null,
      interviewerSpeaking: false,
      hasGreetingStarted: this.isResumedInterview,
      micLevel: 0,
      inputMode: "voice",
      headphones: false,
      deadlineMs: detail.deadline_at ? Date.parse(detail.deadline_at) - offset : null,
      clockOffsetMs: offset,
      currentHasAnswer: false,
      notice: null,
    };
    this.startedSession = Boolean(detail.started_at);
  }

  recordPhase(phase: string, timestamp = performance.now()) {
    if (this.phaseTimings[phase]) return;
    this.phaseTimings[phase] = timestamp;
    const elapsed = Math.round(timestamp - this.startClickedAt);
    console.info(`[TTFR] ${phase}: (elapsed: ${elapsed}ms)`);
  }

  // ----------------------------------------------------------------- store API

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private update(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private setDeadline(clientDeadlineMs: number, offset: number) {
    this.update({ deadlineMs: clientDeadlineMs, clockOffsetMs: offset });
  }

  remainingSeconds(): number | null {
    if (this.snapshot.deadlineMs === null) return null;
    return Math.max(0, Math.round((this.snapshot.deadlineMs - Date.now()) / 1000));
  }

  // ----------------------------------------------------------------- questions

  private get questions() {
    return this.snapshot.questions;
  }

  private firstOpenIndex(): number | null {
    const i = this.questions.findIndex((q) => q.status !== "answered" && q.status !== "skipped");
    return i === -1 ? null : i;
  }

  private setQuestionStatus(index: number, status: QuestionOut["status"]) {
    const questions = this.questions.map((q, i) => (i === index ? { ...q, status } : q));
    this.update({ questions });
  }

  private emit(event: Omit<InterviewEvent, "client_event_id">, immediate = false) {
    this.queue.push({ client_event_id: newId(), ...event } as InterviewEvent, { immediate });
  }

  private activate(index: number | null) {
    this.update({ currentIndex: index, currentHasAnswer: false });
    if (index === null) {
      this.buffer = null;
      return;
    }
    const q = this.questions[index];
    if (!q) return;
    this.buffer = { questionId: q.id, exchange: [], candidateText: [], typed: false, voiced: false };
    if (q.status === "pending") {
      this.setQuestionStatus(index, "asked");
      this.emit({ event_type: "question_asked", question_id: q.id });
    }
  }

  private addLine(speaker: "interviewer" | "candidate", text: string) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const questionId = this.buffer?.questionId;
    this.update({ transcript: [...this.snapshot.transcript, { speaker, text: clean, question_id: questionId }] });
    this.emit({ event_type: "transcript_segment", speaker, text: clean.slice(0, 8000), question_id: questionId });
    if (this.buffer) {
      this.buffer.exchange.push({ speaker, text: clean.slice(0, 8000) });
      if (speaker === "candidate") {
        this.buffer.candidateText.push(clean);
        this.update({ currentHasAnswer: true });
      }
    }
  }

  private finalizePartials() {
    if (this.interviewerPartial.trim()) this.addLine("interviewer", this.interviewerPartial);
    this.interviewerPartial = "";
    if (this.candidatePartial.trim()) {
      if (this.buffer) this.buffer.voiced = true;
      this.addLine("candidate", this.candidatePartial);
    }
    this.candidatePartial = "";
    this.update({ partial: null });
  }

  /** Submit the buffered answer for the active question, if there is one. */
  private submitCurrentAnswer(): boolean {
    const index = this.snapshot.currentIndex;
    const buffer = this.buffer;
    if (index === null || !buffer || buffer.candidateText.length === 0) return false;
    this.emit({
      event_type: "answer_submitted",
      question_id: buffer.questionId,
      answer_source: buffer.typed && !buffer.voiced ? "text" : "voice",
      transcript_text: buffer.candidateText.join("\n").slice(0, 20000),
      exchange: buffer.exchange.slice(-60),
    });
    this.setQuestionStatus(index, "answered");
    buffer.candidateText = [];
    buffer.exchange = [];
    this.update({ currentHasAnswer: false });
    return true;
  }

  // ----------------------------------------------------------------- connection

  async start(): Promise<void> {
    this.closingIntentionally = false;
    this.update({ phase: "connecting", notice: "Connecting to your interviewer…", error: null });
    // Flush left-over events from prior page loads in background without blocking connect
    void this.queue.flush();
    try {
      this.capture = new MicCapture(
        this.deps.ctx,
        this.deps.mic,
        (pcm) => this.sendAudio(pcm),
        (level) => this.update({ micLevel: level }),
      );
      await this.capture.start();
      this.recordPhase("AudioContext/worklet ready");
    } catch {
      this.fail({
        title: "The microphone couldn't start",
        message: "Reload the page and allow microphone access when asked.",
        retryable: true,
      });
      return;
    }
    await this.connect(false);
  }

  private async connect(isReconnect: boolean): Promise<void> {
    this.isReconnectSession = isReconnect;
    this.connectStartedAt = performance.now();
    let token: LiveTokenOut;
    try {
      token = isReconnect
        ? await interviewsApi.liveToken(this.deps.detail.id, { forceFresh: true })
        : await (this.deps.token ?? interviewsApi.liveToken(this.deps.detail.id));
      this.recordPhase("live token received");
    } catch (e) {
      if (e instanceof ApiError && ["INTERVIEW_TIME_EXPIRED"].includes(e.code)) {
        void this.finish("time_expired");
        return;
      }
      if (e instanceof ApiError && e.code === "INTERVIEW_NOT_JOINABLE") {
        this.fail({
          title: "This interview has ended",
          message: "Open your dashboard to see its report.",
          retryable: false,
        });
        return;
      }
      this.handleConnectFailure(isReconnect, e);
      return;
    }
    const offset = Date.parse(token.server_time) - Date.now();
    if (token.deadline_at) this.setDeadline(Date.parse(token.deadline_at) - offset, offset);

    const config = {
      ...token.connect_config,
      sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
    } as unknown as LiveConnectConfig;

    const generation = ++this.generation;
    try {
      const ai = new GoogleGenAI({ apiKey: token.token, httpOptions: { apiVersion: token.api_version } });
      this.session = await ai.live.connect({
        model: token.model,
        config,
        callbacks: {
          onmessage: (m: LiveServerMessage) => {
            if (generation === this.generation) this.onMessage(m);
          },
          onerror: () => {
            /* onclose follows and handles recovery */
          },
          onclose: (e: CloseEvent) => {
            if (generation === this.generation) this.onClose(e);
          },
        },
      });
      if ((this.session as { setupComplete?: unknown } | null)?.setupComplete) {
        this.recordPhase("Live session connected (setupComplete)");
        this.maybeSendKickoff();
      }
    } catch (e) {
      if (this.resumptionHandle) {
        // A stale resumption handle shouldn't block a fresh session; the server-built
        // instructions already include progress.
        this.resumptionHandle = null;
        this.storeHandle(null);
      }
      this.handleConnectFailure(isReconnect, e);
      return;
    }
    this.reconnectAttempts = 0;
    this.update({ phase: "live", notice: null, error: null });
    if (isReconnect) {
      this.emit({ event_type: "reconnected" });
      this.emit({ event_type: "resumed" });
    }

    const wasStarted = this.startedSession;
    if (!this.startedSession) {
      this.startedSession = true;
      interviewsApi.events(this.deps.detail.id, [
        { client_event_id: newId(), event_type: "session_started" },
      ]).then((result) => {
        if (result.remaining_seconds !== null) {
          this.setDeadline(Date.now() + result.remaining_seconds * 1000, this.snapshot.clockOffsetMs);
        }
      }).catch(() => {
        this.emit({ event_type: "session_started" }, true);
      });
    }
    const isFresh =
      !isReconnect && !wasStarted && this.questions.every((q) => q.status === "pending");
    if (!isFresh && this.snapshot.currentIndex === null) {
      this.activate(this.firstOpenIndex());
    }
    if (isReconnect && !this.resumptionHandle) {
      this.sendControl("The connection dropped and has been restored. Continue the interview from where it stopped.");
    }
    this.startClock();
  }

  private maybeSendKickoff() {
    const isFresh = !this.isReconnectSession && !this.isResumedInterview;
    if (isFresh && !this.kickoffSent && this.session) {
      this.kickoffSent = true;
      this.recordPhase("kickoff sent");
      try {
        this.session.sendRealtimeInput({
          text: `${CONTROL} The candidate has joined. Greet them now and begin.`,
        });
      } catch {
        /* ignore */
      }
    }
  }

  private handleConnectFailure(isReconnect: boolean, error: unknown) {
    this.emit({ event_type: "metric", metric_name: "live_connection_failed", metric_value: 1 });
    if (error instanceof ApiError && !error.retryable) {
      this.fail({ title: "Couldn't connect to the interviewer", message: error.message, retryable: true });
      return;
    }
    if (isReconnect || this.reconnectAttempts > 0) {
      this.scheduleReconnect();
      return;
    }
    this.fail({
      title: "Couldn't connect to the interviewer",
      message: `${errorMessage(error)} Check your connection and try again.`,
      retryable: true,
    });
  }

  private onClose(e: CloseEvent) {
    this.session = null;
    if (this.closingIntentionally || this.snapshot.phase === "ending" || this.snapshot.phase === "ended") return;
    this.player.clear();
    this.finalizePartials();
    // Policy violations / bad tokens won't fix themselves with retries.
    if (e.code === 1008 || e.code === 1007) {
      this.fail({
        title: "The AI service closed the session",
        message: e.reason || "The session was rejected. Try again in a minute.",
        retryable: true,
      });
      return;
    }
    this.emit({ event_type: "connection_lost", reason: (e.reason || `code ${e.code}`).slice(0, 200) });
    this.emit({ event_type: "paused" });
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECTS) {
      this.fail({
        title: "Connection lost",
        message:
          "We couldn't reconnect to the interviewer. Your answers so far are saved. Try reconnecting, or end the interview to get a report.",
        retryable: true,
      });
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(15_000, 1000 * 2 ** (this.reconnectAttempts - 1));
    this.update({ phase: "reconnecting", notice: "Reconnecting to the interviewer…" });
    setTimeout(() => {
      if (this.snapshot.phase === "reconnecting") void this.connect(true);
    }, delay);
  }

  /** Manual retry from the error state. */
  async retry() {
    this.reconnectAttempts = 0;
    this.update({ error: null });
    if (!this.capture) await this.start();
    else await this.connect(true);
  }

  private fail(error: LiveError) {
    this.update({ phase: "error", error, notice: null });
  }

  private storeHandle(handle: string | null) {
    try {
      const key = `mi-resume-${this.deps.detail.id}`;
      if (handle) sessionStorage.setItem(key, handle);
      else sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  // ----------------------------------------------------------------- streaming

  private sendAudio(base64Pcm: string) {
    if (!this.session || this.snapshot.phase !== "live") return;
    if (this.snapshot.inputMode === "text") return;
    // Don't send mic audio before the interviewer has started speaking the greeting so the candidate doesn't talk over it
    if (!this.snapshot.hasGreetingStarted) return;
    // Without headphones the mic hears the interviewer; pause the mic while it speaks
    // so it doesn't interrupt itself.
    if (!this.snapshot.headphones && this.player.isPlaying) return;
    try {
      this.session.sendRealtimeInput({ audio: { data: base64Pcm, mimeType: "audio/pcm;rate=16000" } });
    } catch {
      /* socket closing; onclose handles it */
    }
  }

  private sendControl(instruction: string) {
    try {
      this.session?.sendRealtimeInput({ text: `${CONTROL} ${instruction}` });
    } catch {
      /* ignore while reconnecting */
    }
  }

  private onMessage(message: LiveServerMessage) {
    if ("setupComplete" in message || Boolean((message as unknown as { setupComplete?: unknown }).setupComplete)) {
      this.recordPhase("Live session connected (setupComplete)");
      this.maybeSendKickoff();
    }
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
      this.storeHandle(this.resumptionHandle);
    }
    if (message.goAway) {
      // The server will close soon; reconnect proactively with the resumption handle.
      const old = this.session;
      this.generation += 1; // ignore the old socket's close event
      this.session = null;
      try {
        old?.close();
      } catch {
        /* already closing */
      }
      this.update({ phase: "reconnecting", notice: "Refreshing the connection…" });
      void this.connect(true);
      return;
    }
    if (message.toolCall?.functionCalls?.length) {
      this.handleToolCalls(message.toolCall.functionCalls);
    }
    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      this.player.clear();
      if (this.interviewerPartial.trim()) this.addLine("interviewer", `${this.interviewerPartial.trim()}…`);
      this.interviewerPartial = "";
    }
    if (content.inputTranscription?.text) {
      // The candidate is speaking: a pending interviewer line is complete.
      if (this.interviewerPartial.trim()) {
        this.addLine("interviewer", this.interviewerPartial);
        this.interviewerPartial = "";
      }
      this.candidatePartial += content.inputTranscription.text;
      this.update({ partial: { speaker: "candidate", text: this.candidatePartial } });
    }
    const parts = content.modelTurn?.parts ?? [];
    const hasModelOutput = parts.some((p) => p.inlineData?.data) || Boolean(content.outputTranscription?.text);
    if (hasModelOutput && this.candidatePartial.trim()) {
      if (this.buffer) this.buffer.voiced = true;
      this.addLine("candidate", this.candidatePartial);
      this.candidatePartial = "";
    }
    for (const part of parts) {
      const data = part.inlineData?.data;
      if (data && part.inlineData?.mimeType?.startsWith("audio/")) {
        if (!this.firstAudioReported) {
          this.firstAudioReported = true;
          this.recordPhase("first audio chunk received");
          this.recordPhase("first audio played");
          this.update({ hasGreetingStarted: true, notice: null });
          const totalMs = Math.round(performance.now() - this.startClickedAt);
          this.emit({
            event_type: "metric",
            metric_name: "time_to_first_response_ms",
            metric_value: totalMs,
          });
          console.info("[TTFR Breakdown]", {
            ...this.phaseTimings,
            total_ttfr_ms: totalMs,
          });
        }
        if (!this.turnStartedAt) this.turnStartedAt = performance.now();
        this.player.enqueue(data, parseSampleRate(part.inlineData?.mimeType));
      }
    }
    if (content.outputTranscription?.text) {
      this.interviewerPartial += content.outputTranscription.text;
      this.update({ partial: { speaker: "interviewer", text: this.interviewerPartial } });
    }
    if (content.turnComplete) {
      if (this.interviewerPartial.trim()) this.addLine("interviewer", this.interviewerPartial);
      this.interviewerPartial = "";
      this.update({ partial: null });
      if (this.turnStartedAt) {
        this.emit({
          event_type: "metric",
          metric_name: "ai_turn_duration_ms",
          metric_value: Math.round(performance.now() - this.turnStartedAt),
        });
        this.turnStartedAt = 0;
      }
    }
  }

  private handleToolCalls(calls: { id?: string; name?: string; args?: Record<string, unknown> }[]) {
    const responses = calls.map((call) => {
      if (call.name === "advance_to_question") {
        return { id: call.id, name: call.name, response: this.advanceTo(Number(call.args?.next_question_number)) };
      }
      if (call.name === "end_interview") {
        setTimeout(() => void this.finish("all_questions_done"), 2500);
        return { id: call.id, name: call.name, response: { ok: true } };
      }
      return { id: call.id, name: call.name, response: { error: "Unknown function" } };
    });
    try {
      this.session?.sendToolResponse({ functionResponses: responses });
    } catch {
      /* reconnect path re-sends context through instructions */
    }
  }

  /** Move to a planned question. Returns the payload for the model. */
  private advanceTo(requested: number): Record<string, unknown> {
    this.finalizePartials();
    this.submitCurrentAnswer();
    const open = (i: number) => {
      const q = this.questions[i];
      return q && q.status !== "answered" && q.status !== "skipped";
    };
    let index = this.questions.findIndex((q) => q.sequence_number === requested);
    if (index === -1 || !open(index)) {
      const next = this.questions.findIndex(
        (q, i) => i > (this.snapshot.currentIndex ?? -1) && q.status !== "answered" && q.status !== "skipped",
      );
      index = next === -1 ? (this.firstOpenIndex() ?? -1) : next;
    }
    const remaining = this.remainingSeconds();
    if (index === -1) {
      this.activate(null);
      return {
        done: true,
        instruction:
          "All planned questions are complete. Thank the candidate in one sentence, then call end_interview.",
      };
    }
    this.activate(index);
    const q = this.questions[index]!;
    return {
      question_number: q.sequence_number,
      question_text: q.question_text,
      remaining_minutes: remaining === null ? undefined : Math.floor(remaining / 60),
      instruction: "Ask this question now.",
    };
  }

  // ----------------------------------------------------------------- controls

  setHeadphones(on: boolean) {
    this.update({ headphones: on });
  }

  setInputMode(mode: "voice" | "text") {
    if (mode === this.snapshot.inputMode) return;
    this.update({ inputMode: mode });
    if (this.capture) this.capture.muted = mode === "text";
    if (mode === "text") {
      try {
        this.session?.sendRealtimeInput({ audioStreamEnd: true });
      } catch {
        /* ignore */
      }
    }
  }

  submitTypedAnswer(text: string): boolean {
    const clean = text.trim();
    if (!clean || !this.session || this.snapshot.phase !== "live") return false;
    this.finalizePartials();
    if (this.buffer) this.buffer.typed = true;
    this.addLine("candidate", clean);
    this.player.clear();
    try {
      this.session.sendRealtimeInput({ text: clean });
    } catch {
      return false;
    }
    return true;
  }

  skipCurrent() {
    const index = this.snapshot.currentIndex;
    if (index === null || this.snapshot.phase !== "live") return;
    const q = this.questions[index];
    if (!q) return;
    this.player.clear();
    this.finalizePartials();
    this.emit({ event_type: "question_skipped", question_id: q.id }, true);
    this.setQuestionStatus(index, "skipped");
    if (this.buffer) {
      this.buffer.candidateText = [];
      this.buffer.exchange = [];
    }
    const next = this.questions.findIndex((x, i) => i > index && x.status !== "answered" && x.status !== "skipped");
    const target = next === -1 ? this.firstOpenIndex() : next;
    this.activate(target);
    if (target === null) {
      this.sendControl("The candidate skipped the last question. Thank them in one sentence, then call end_interview.");
      return;
    }
    const nq = this.questions[target]!;
    this.sendControl(
      `The candidate chose to skip question ${q.sequence_number}. Say "No problem" and ask question ${nq.sequence_number}: ${nq.question_text}`,
    );
  }

  retakeCurrent() {
    const index = this.snapshot.currentIndex;
    if (index === null || this.snapshot.phase !== "live" || !this.buffer) return;
    const q = this.questions[index];
    if (!q) return;
    this.player.clear();
    this.finalizePartials();
    // Keep the original attempt: submit it first, then open a retake.
    const hadAnswer = this.submitCurrentAnswer() || q.status === "answered";
    if (!hadAnswer) return;
    this.emit({ event_type: "answer_retake", question_id: q.id }, true);
    this.setQuestionStatus(index, "retaking");
    this.buffer = { questionId: q.id, exchange: [], candidateText: [], typed: false, voiced: false };
    this.update({ currentHasAnswer: false });
    this.sendControl(
      `The candidate wants to retake their answer to question ${q.sequence_number}. Briefly invite them to answer again from the start. Do not comment on their previous answer.`,
    );
  }

  // ----------------------------------------------------------------- timer

  private startClock() {
    if (this.timerHandle) return;
    this.timerHandle = setInterval(() => {
      const remaining = this.remainingSeconds();
      if (remaining === null || this.snapshot.phase === "ending" || this.snapshot.phase === "ended") return;
      if (remaining <= 120 && !this.warnedTwoMinutes && this.snapshot.phase === "live") {
        this.warnedTwoMinutes = true;
        this.sendControl(
          "About two minutes remain. Don't start optional questions. Let the candidate finish, then thank them and call end_interview.",
        );
      }
      if (remaining <= 0) void this.finish("time_expired");
    }, 1000);
  }

  /** Deliver any batched events immediately. */
  async flushEvents(): Promise<void> {
    await this.queue.flush();
  }

  /** End the interview. Idempotent: safe to call from several places. */
  finish(reason: "user_ended" | "time_expired" | "all_questions_done"): Promise<void> {
    if (this.finishing) return this.finishing;
    this.finishing = (async () => {
      this.update({ phase: "ending", notice: "Saving your interview…" });
      this.closingIntentionally = true;
      if (this.timerHandle) clearInterval(this.timerHandle);
      this.timerHandle = null;
      this.finalizePartials();
      this.submitCurrentAnswer();
      this.player.clear();
      try {
        this.session?.close();
      } catch {
        /* already closed */
      }
      this.session = null;
      this.capture?.stop();
      this.capture = null;
      await this.queue.flush();
      try {
        await interviewsApi.complete(this.deps.detail.id, reason);
      } catch (e) {
        // The backend also auto-finalizes after the deadline; the processing page polls status.
        console.warn("complete failed", errorMessage(e));
      }
      this.storeHandle(null);
      this.update({ phase: "ended", notice: null });
      this.onFinished?.(reason);
    })();
    return this.finishing;
  }

  /** Release audio resources without ending the interview (page unload). */
  dispose() {
    this.closingIntentionally = true;
    if (this.timerHandle) clearInterval(this.timerHandle);
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    this.capture?.stop();
    this.player.clear();
    void this.queue.flush();
  }

  get pendingEvents() {
    return this.queue.pending;
  }
}
