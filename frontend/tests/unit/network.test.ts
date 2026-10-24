import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowser: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "user-token", expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      }),
      refreshSession: async () => ({ data: { session: null } }),
    },
  }),
}));

import { AI_BUSY_MESSAGE, api, ApiError, errorMessage } from "@/lib/api";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("api client", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends the bearer token and idempotency key", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { id: "x" }));
    await api("/interviews", { method: "POST", body: { a: 1 }, idempotencyKey: "key-123" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/v1/interviews");
    expect(init.headers.Authorization).toBe("Bearer user-token");
    expect(init.headers["Idempotency-Key"]).toBe("key-123");
  });

  it("maps the backend error shape", async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, {
        error: { code: "ANSWER_ALREADY_RECORDED", message: "Use retake.", retryable: false, request_id: "r1" },
      }),
    );
    const err = (await api("/x", { method: "POST" }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("ANSWER_ALREADY_RECORDED");
    expect(err.requestId).toBe("r1");
  });

  it("retries GETs through a cold start", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const result = await api<{ ok: boolean }>("/interviews");
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers from a dropped connection", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(json(200, { ok: 1 }));
    await expect(api("/interviews")).resolves.toEqual({ ok: 1 });
  });

  it("does not retry non-idempotent POSTs by default", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = (await api("/x", { method: "POST" }).catch((e) => e)) as ApiError;
    expect(err.code).toBe("NETWORK_ERROR");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("event queue", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("persists events, retries after network failure, and drops only rejected ones", async () => {
    const calls: string[][] = [];
    let failNext = true;
    vi.doMock("@/services/interviews", () => ({
      interviewsApi: {
        events: vi.fn(async (_id: string, events: { client_event_id: string; event_type: string }[]) => {
          calls.push(events.map((e) => e.client_event_id));
          if (failNext) {
            failNext = false;
            throw Object.assign(new Error("offline"), { retryable: true, status: 0, code: "NETWORK_ERROR" });
          }
          if (events.length > 1 && events.some((e) => e.event_type === "answer_retake")) {
            const { ApiError: E } = await import("@/lib/api");
            throw new E(409, { code: "RETAKE_NOT_ALLOWED", message: "no", retryable: false });
          }
          if (events.length === 1 && events[0]!.event_type === "answer_retake") {
            const { ApiError: E } = await import("@/lib/api");
            throw new E(409, { code: "RETAKE_NOT_ALLOWED", message: "no", retryable: false });
          }
          return { results: [], status: "in_progress", progress: {}, remaining_seconds: 100 };
        }),
      },
    }));
    const { EventQueue } = await import("@/lib/live/event-queue");
    const q = new EventQueue("int-1");
    const dropped: string[] = [];
    q.onDropped = (e) => dropped.push(e.client_event_id);
    q.push({ client_event_id: "aaaaaaaa1", event_type: "question_asked", question_id: "q" });
    q.push({ client_event_id: "aaaaaaaa2", event_type: "answer_retake", question_id: "q" });
    q.push({ client_event_id: "aaaaaaaa3", event_type: "transcript_segment", speaker: "candidate", text: "hi" });
    expect(JSON.parse(localStorage.getItem("mi-events-int-1")!)).toHaveLength(3);

    await q.flush();
    expect(q.pending).toBe(0);
    expect(dropped).toEqual(["aaaaaaaa2"]);
    expect(localStorage.getItem("mi-events-int-1")).toBeNull();
    expect(calls[0]).toHaveLength(3); // first attempt failed offline, then retried
  });

  it("restores undelivered events after a reload", async () => {
    localStorage.setItem("mi-events-int-2", JSON.stringify([{ client_event_id: "bbbbbbbb1", event_type: "metric" }]));
    vi.doMock("@/services/interviews", () => ({ interviewsApi: { events: vi.fn(async () => ({ results: [] })) } }));
    const { EventQueue } = await import("@/lib/live/event-queue");
    const q = new EventQueue("int-2");
    expect(q.pending).toBe(1);
    await q.flush();
    expect(q.pending).toBe(0);
  });
});

describe("errorMessage", () => {
  it("maps 429 and rate limit / quota errors to AI_BUSY_MESSAGE", () => {
    const err429 = new ApiError(429, { code: "RATE_LIMITED", message: "Too many requests", retryable: true });
    expect(errorMessage(err429)).toBe(AI_BUSY_MESSAGE);

    const errQuota = new ApiError(500, {
      code: "AI_PROVIDER_QUOTA_EXHAUSTED",
      message: "Quota exceeded",
      retryable: false,
    });
    expect(errorMessage(errQuota)).toBe(AI_BUSY_MESSAGE);

    const genericError = new Error("Resource_exhausted for model");
    expect(errorMessage(genericError)).toBe(AI_BUSY_MESSAGE);
  });

  it("returns regular error message for other errors", () => {
    const err = new ApiError(400, { code: "INVALID_INPUT", message: "Job description is too short", retryable: false });
    expect(errorMessage(err)).toBe("Job description is too short");

    const generic = new Error("Something broke");
    expect(errorMessage(generic)).toBe("Something broke");
  });
});
