import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@google/genai", async () => await import("./fakes/live-fakes"));
vi.mock("@/services/interviews", async () => await import("./fakes/live-fakes"));
vi.mock("@/lib/live/audio", async () => await import("./fakes/live-fakes"));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseBrowser: () => ({}) }));

import { InterviewConductor } from "@/lib/live/interview-conductor";
import type { InterviewDetail, QuestionOut } from "@/types/api";

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
    expect(JSON.stringify(s1.toolResponses[0])).toContain("Question 2 text?");
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
    for (const n of [2, 3, 4, 5]) {
      s.emit({ serverContent: { inputTranscription: { text: `answer ${n}` } } });
      s.emit({ serverContent: { outputTranscription: { text: "ok" } } });
      s.emit({
        toolCall: { functionCalls: [{ id: `f${n}`, name: "advance_to_question", args: { next_question_number: n } }] },
      });
    }
    expect(JSON.stringify(s.toolResponses.at(-1))).toContain("end_interview");
    await c.finish("all_questions_done");
    expect(eventsOf("answer_submitted")).toHaveLength(4);
  });
});
