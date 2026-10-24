import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
let liveTokenMock = vi.fn();

vi.mock("@google/genai", async () => await import("./fakes/live-fakes"));
vi.mock("@/services/interviews", () => ({
  interviewsApi: {
    get: (id: string) => getMock(id),
    liveToken: (id: string, opts?: unknown) => liveTokenMock(id, opts),
    events: vi.fn(async () => ({ results: [], status: "in_progress", progress: {}, remaining_seconds: 1200 })),
    complete: vi.fn(),
  },
  prefetchLiveToken: vi.fn((id: string) => {
    try {
      liveTokenMock(id).catch(() => {});
    } catch {
      /* ignore */
    }
  }),
}));

vi.mock("@/lib/live/audio", async () => {
  const actual = await import("./fakes/live-fakes");
  return {
    ...actual,
    preloadAudioWorklet: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowser: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "test-int-1" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/interview/test-int-1/live",
}));

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));

import LivePage from "@/app/interview/[id]/live/page";
import type { InterviewDetail, QuestionOut } from "@/types/api";
import { live } from "./fakes/live-fakes";

const q = (n: number): QuestionOut => ({
  id: `q${n}`,
  sequence_number: n,
  question_text: `Question ${n}?`,
  competency: "Coding",
  difficulty: 3,
  question_type: "technical",
  priority: "core",
  time_allocation_seconds: 120,
  status: "pending",
});

function detail(): InterviewDetail {
  return {
    id: "test-int-1",
    job_role: "Senior Software Engineer",
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
    questions: [q(1), q(2)],
    objectives: [],
    attempts: {},
    transcript: [],
    server_time: new Date().toISOString(),
  };
}

describe("LivePage Join Flow", () => {
  let getUserMediaMock: ReturnType<typeof vi.fn>;
  let audioContextCreated: boolean;

  beforeEach(() => {
    live.reset();
    audioContextCreated = false;
    getMock.mockResolvedValue(detail());
    liveTokenMock = vi.fn(async () => ({
      provider: "fake",
      token: "auth_tokens/sample",
      model: "fake-live",
      api_version: "v1alpha",
      expires_at: new Date(Date.now() + 1800e3).toISOString(),
      new_session_expires_at: new Date(Date.now() + 60e3).toISOString(),
      connect_config: { responseModalities: ["AUDIO"] },
      deadline_at: null,
      server_time: new Date().toISOString(),
    }));

    getUserMediaMock = vi.fn(async () => ({
      getTracks: () => [{ stop: vi.fn() }],
    }));

    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: getUserMediaMock,
      },
    });

    class MockAudioContext {
      state = "running";
      audioWorklet = { addModule: vi.fn(async () => {}) };
      createGain() {
        return { connect: vi.fn() };
      }
      createMediaStreamDestination() {
        return { stream: {} };
      }
      createMediaStreamSource() {
        return { connect: vi.fn() };
      }
      async resume() {}
      async close() {}
      constructor() {
        audioContextCreated = true;
      }
    }

    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("AudioContext", MockAudioContext);
  });

  it("The Join button is enabled after load even when the token prefetch is pending or has failed", async () => {
    // Simulate prefetch promise that is pending or fails
    liveTokenMock.mockReturnValue(new Promise(() => {})); // Never resolves

    render(<LivePage />);

    // Wait for interview detail to load
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /join interview/i })).toBeInTheDocument();
    });

    const joinBtn = screen.getByRole("button", { name: /join interview/i });
    expect(joinBtn).toBeEnabled();
  });

  it("Clicking Join calls getUserMedia and creates AudioContext inside the click handler, then connects and sends kickoff on setupComplete", async () => {
    render(<LivePage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /join interview/i })).toBeInTheDocument();
    });

    expect(getUserMediaMock).not.toHaveBeenCalled();
    expect(audioContextCreated).toBe(false);

    const joinBtn = screen.getByRole("button", { name: /join interview/i });
    await userEvent.click(joinBtn);

    // Both getUserMedia and AudioContext are initialized inside the click handler
    expect(getUserMediaMock).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.any(Object) }));
    expect(audioContextCreated).toBe(true);

    // Conductor connects and setupComplete triggers kickoff
    await waitFor(() => {
      expect(live.sessions.length).toBeGreaterThan(0);
    });

    const session = live.sessions[0]!;
    session.emit({ setupComplete: {} });

    await waitFor(() => {
      expect(session.texts).toContain("[CONTROL] The candidate has joined. Greet them now and begin.");
    });
  });

  it("A token fetch that rejects or times out shows the error message, re-enables the button, and Try again works", async () => {
    render(<LivePage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /join interview/i })).toBeInTheDocument();
    });

    // Make token fetch fail on click
    liveTokenMock.mockRejectedValue(new Error("Network failure"));

    const joinBtn = screen.getByRole("button", { name: /join interview/i });
    await userEvent.click(joinBtn);

    // Shows clear error message and switches button to "Try again"
    await waitFor(() => {
      expect(screen.getByText("Couldn't connect to the interviewer. Check your mic permission and try again.")).toBeInTheDocument();
    });

    const retryBtn = screen.getByRole("button", { name: /try again/i });
    expect(retryBtn).toBeEnabled();

    // Now resolve next attempt
    liveTokenMock.mockResolvedValue({
      provider: "fake",
      token: "auth_tokens/success",
      model: "fake-live",
      api_version: "v1alpha",
      expires_at: new Date(Date.now() + 1800e3).toISOString(),
      new_session_expires_at: new Date(Date.now() + 60e3).toISOString(),
      connect_config: { responseModalities: ["AUDIO"] },
      deadline_at: null,
      server_time: new Date().toISOString(),
    });

    await userEvent.click(retryBtn);

    // On retry, successfully connects
    await waitFor(() => {
      expect(live.sessions.length).toBeGreaterThan(0);
    });
  });
});
