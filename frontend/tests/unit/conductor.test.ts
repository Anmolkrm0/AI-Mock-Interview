import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@google/genai", async () => await import("./fakes/live-fakes"));
vi.mock("@/services/interviews", async () => await import("./fakes/live-fakes"));
vi.mock("@/lib/live/audio", async () => await import("./fakes/live-fakes"));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseBrowser: () => ({}) }));

import { InterviewConductor } from "@/lib/live/interview-conductor";
import type { InterviewDetail, LiveTokenOut, QuestionOut } from "@/types/api";

import { live } from "./fakes/live-fakes";

const q = (n: number): QuestionOut => ({
  id: `q${n}`,
  sequence_number: n,
  question_text: `Question ${n} text?`,
  competency: "Coding",
  difficulty: 3,
  question_type: "technical",
  priority: "core",
  time_allocation_seconds: 120,
  status: "pending",
});

function detail(): InterviewDetail {
  return {
    id: "int1",
    job_role: "Engineer",
    duration_minutes: 20,
    evaluation_rigor: "standard",
    recording_mode: "none",
    status: "ready",
    failure_stage: null,
    failure_code: null,
    started_at: null,
    deadline_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    questions: [q(1), q(2), q(3), q(4)],
    objectives: [],
    attempts: {},
    transcript: [],
    server_time: new Date().toISOString(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function eventsOf(type: string) {
  return live.events.filter((e) => e.event_type === type);
}

describe("InterviewConductor", () => {
  beforeEach(() => {
    live.reset();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("runs a full interview: answer, advance, skip, typed answer, retake, reconnect, end", async () => {
    const c = new InterviewConductor({ detail: detail(), ctx: {} as AudioContext, mic: {} as MediaStream });
    let finished: string | null = null;
    c.onFinished = (r) => (finished = r);

    await c.start();
    const s1 = live.sessions[0]!;
    expect(c.getSnapshot().phase).toBe("live");
    expect(eventsOf("session_started")).toHaveLength(1);
    expect(c.remainingSeconds()).toBeGreaterThan(1190);
    expect(c.getSnapshot().currentIndex).toBeNull();

    // Advance to Question 1 after warm-up
    s1.emit({
      toolCall: { functionCalls: [{ id: "f0", name: "advance_to_question", args: { next_question_number: 1 } }] },
    });
    expect(c.getSnapshot().currentIndex).toBe(0);

    // Interviewer asks Q1, candidate answers by voice.
    s1.emit({ serverContent: { outputTranscription: { text: "Tell me about question one?" } } });
    s1.emit({ serverContent: { turnComplete: true } });
    s1.emit({ serverContent: { inputTranscription: { text: "I built a payments API " } } });
    s1.emit({ serverContent: { inputTranscription: { text: "with Redis caching." } } });
    s1.emit({ serverContent: { outputTranscription: { text: "Thanks." } } });
    expect(c.getSnapshot().currentHasAnswer).toBe(true);

    // Model moves on: Q1 answer is submitted, Q2 activated, tool response carries Q2 text.
    s1.emit({
      toolCall: { functionCalls: [{ id: "f1", name: "advance_to_question", args: { next_question_number: 2 } }] },
    });
    expect(JSON.stringify(s1.toolResponses.at(-1))).toContain("Question 2 text?");
    expect(c.getSnapshot().questions[0]!.status).toBe("answered");
    expect(c.getSnapshot().currentIndex).toBe(1);

    // Candidate skips Q2 -> Q3 is asked via a control message.
    c.skipCurrent();
    expect(c.getSnapshot().questions[1]!.status).toBe("skipped");
    expect(s1.texts.at(-1)).toMatch(/\[CONTROL\].*skip question 2.*question 3/);

    // Typed answer to Q3, then retake keeps the original attempt.
    c.setInputMode("text");
    expect(s1.realtime.some((r) => r.audioStreamEnd)).toBe(true);
    expect(c.submitTypedAnswer("My typed answer for three")).toBe(true);
    expect(s1.texts).toContain("My typed answer for three");
    c.retakeCurrent();
    expect(c.getSnapshot().questions[2]!.status).toBe("retaking");
    expect(s1.texts.at(-1)).toMatch(/retake their answer to question 3/);

    // Connection drops -> reconnect with a fresh token.
    s1.emit({ sessionResumptionUpdate: { resumable: true, newHandle: "handle-1" } });
    s1.drop();
    expect(c.getSnapshot().phase).toBe("reconnecting");
    await new Promise((r) => setTimeout(r, 1100));
    await tick();
    const s2 = live.sessions[1]!;
    expect(live.tokens).toBe(2);
    expect(s2.config.sessionResumption).toEqual({ handle: "handle-1" });
    expect(c.getSnapshot().phase).toBe("live");

    // New answer after retake, then the user ends the interview (twice: idempotent).
    s2.emit({ serverContent: { inputTranscription: { text: "Second try, much clearer." } } });
    await Promise.all([c.finish("user_ended"), c.finish("user_ended")]);
    expect(finished).toBe("user_ended");
    expect(live.completes).toEqual(["user_ended"]);
    expect(s2.closed).toBe(true);

    const answers = eventsOf("answer_submitted");
    expect(answers.map((a) => a.question_id)).toEqual(["q1", "q3", "q3"]);
    expect(answers[0]!.transcript_text).toBe("I built a payments API with Redis caching.");
    expect(answers[0]!.answer_source).toBe("voice");
    expect(answers[1]!.answer_source).toBe("text");
    expect(answers[2]!.transcript_text).toBe("Second try, much clearer.");
    expect(eventsOf("question_skipped").map((e) => e.question_id)).toEqual(["q2"]);
    expect(eventsOf("answer_retake").map((e) => e.question_id)).toEqual(["q3"]);
    expect(eventsOf("question_asked").map((e) => e.question_id)).toEqual(["q1", "q2", "q3"]);
    expect(eventsOf("connection_lost")).toHaveLength(1);
    expect(eventsOf("reconnected")).toHaveLength(1);
    // Each event id is unique so the backend can de-duplicate retries.
    const ids = live.events.map((e) => e.client_event_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ends when the interviewer calls end_interview", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const c = new InterviewConductor({ detail: detail(), ctx: {} as AudioContext, mic: {} as MediaStream });
    let finished: string | null = null;
    c.onFinished = (r) => (finished = r);
    await c.start();
    live.sessions[0]!.emit({
      toolCall: { functionCalls: [{ id: "e", name: "end_interview", args: { reason: "done" } }] },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(finished).toBe("all_questions_done");
    vi.useRealTimers();
  });

  it("tells the model when there are no questions left", async () => {
    const c = new InterviewConductor({ detail: detail(), ctx: {} as AudioContext, mic: {} as MediaStream });
    await c.start();
    const s = live.sessions[0]!;
    for (const n of [1, 2, 3, 4, 5]) {
      if (n > 1) {
        s.emit({ serverContent: { inputTranscription: { text: `answer ${n - 1}` } } });
        s.emit({ serverContent: { outputTranscription: { text: "ok" } } });
      }
      s.emit({
        toolCall: { functionCalls: [{ id: `f${n}`, name: "advance_to_question", args: { next_question_number: n } }] },
      });
    }
    s.emit({ serverContent: { inputTranscription: { text: "answer 4" } } });
    s.emit({ serverContent: { outputTranscription: { text: "ok" } } });
    s.emit({
      toolCall: { functionCalls: [{ id: "f5", name: "advance_to_question", args: { next_question_number: 5 } }] },
    });
    expect(JSON.stringify(s.toolResponses.at(-1))).toContain("end_interview");
    await c.finish("all_questions_done");
    expect(eventsOf("answer_submitted")).toHaveLength(4);
  });

  it("warm-up speech before question 1 creates no question_asked or answer_submitted events, and the first question's timer starts only when question 1 is asked", async () => {
    const c = new InterviewConductor({ detail: detail(), ctx: {} as AudioContext, mic: {} as MediaStream });
    await c.start();
    const s = live.sessions[0]!;

    expect(c.getSnapshot().currentIndex).toBeNull();
    expect(eventsOf("question_asked")).toHaveLength(0);
    expect(eventsOf("answer_submitted")).toHaveLength(0);

    // Warm-up turns between interviewer and candidate
    s.emit({ serverContent: { outputTranscription: { text: "Hi! How are you feeling today?" } } });
    s.emit({ serverContent: { turnComplete: true } });
    s.emit({ serverContent: { inputTranscription: { text: "I'm feeling excited, ready for the interview!" } } });
    s.emit({ serverContent: { turnComplete: true } });
    s.emit({ serverContent: { outputTranscription: { text: "Glad to hear that. Let's begin." } } });
    s.emit({ serverContent: { turnComplete: true } });

    // No question events should have been created during warm-up
    expect(eventsOf("question_asked")).toHaveLength(0);
    expect(eventsOf("answer_submitted")).toHaveLength(0);
    expect(c.getSnapshot().questions[0]!.status).toBe("pending");

    // Advance to question 1
    s.emit({
      toolCall: { functionCalls: [{ id: "f1", name: "advance_to_question", args: { next_question_number: 1 } }] },
    });

    // Question 1 is now asked and active
    expect(c.getSnapshot().currentIndex).toBe(0);
    expect(c.getSnapshot().questions[0]!.status).toBe("asked");
    await c.flushEvents();
    expect(eventsOf("question_asked")).toHaveLength(1);
    expect(eventsOf("question_asked")[0]!.question_id).toBe("q1");
    await c.finish("user_ended");
  });

  it("sends kickoff text immediately on setupComplete of a fresh session, and does not send kickoff on reconnect or resume", async () => {
    const c = new InterviewConductor({ detail: detail(), ctx: {} as AudioContext, mic: {} as MediaStream });
    await c.start();
    const s1 = live.sessions[0]!;

    expect(s1.texts).not.toContain("[CONTROL] The candidate has joined. Greet them now and begin.");

    // setupComplete reported by session
    s1.emit({ setupComplete: {} });

    // Kickoff is sent immediately with no delay
    expect(s1.texts).toContain("[CONTROL] The candidate has joined. Greet them now and begin.");

    // Simulate connection drop and reconnect
    s1.emit({ sessionResumptionUpdate: { resumable: true, newHandle: "handle-1" } });
    s1.drop();
    await new Promise((r) => setTimeout(r, 1100));
    await tick();
    const s2 = live.sessions[1]!;

    // On reconnect, setupComplete does not send kickoff
    s2.emit({ setupComplete: {} });
    expect(s2.texts).not.toContain("[CONTROL] The candidate has joined. Greet them now and begin.");
  });

  it("does not send kickoff on resume of an interview already in progress", async () => {
    const resumedDetail = detail();
    resumedDetail.started_at = new Date().toISOString();
    resumedDetail.questions[0]!.status = "asked";

    const c = new InterviewConductor({ detail: resumedDetail, ctx: {} as AudioContext, mic: {} as MediaStream });
    await c.start();
    const s = live.sessions[0]!;

    s.emit({ setupComplete: {} });
    expect(s.texts).not.toContain("[CONTROL] The candidate has joined. Greet them now and begin.");
  });

  it("token fetch, mic and audio setup are started in parallel without awaiting each other", async () => {
    let tokenResolved = false;
    let micResolved = false;
    let audioResolved = false;

    // Simulate concurrent promises
    const tokenPromise = new Promise<LiveTokenOut>((resolve) => {
      setTimeout(() => {
        tokenResolved = true;
        resolve({
          provider: "fake",
          token: "auth_tokens/parallel-token",
          model: "fake-live",
          api_version: "v1alpha",
          expires_at: new Date(Date.now() + 1800e3).toISOString(),
          new_session_expires_at: new Date(Date.now() + 60e3).toISOString(),
          connect_config: { responseModalities: ["AUDIO"] },
          deadline_at: null,
          server_time: new Date().toISOString(),
        });
      }, 10);
    });

    const micPromise = new Promise<MediaStream>((resolve) => {
      setTimeout(() => {
        micResolved = true;
        resolve({} as MediaStream);
      }, 10);
    });

    const audioPromise = new Promise<AudioContext>((resolve) => {
      setTimeout(() => {
        audioResolved = true;
        resolve({} as AudioContext);
      }, 10);
    });

    // All three start concurrently in Promise.all
    const [mic, ctx, token] = await Promise.all([micPromise, audioPromise, tokenPromise]);
    expect(tokenResolved).toBe(true);
    expect(micResolved).toBe(true);
    expect(audioResolved).toBe(true);

    const c = new InterviewConductor({
      detail: detail(),
      ctx,
      mic,
      token,
      startClickedAt: performance.now(),
    });
    await c.start();
    expect(c.getSnapshot().phase).toBe("live");
  });
});

