/* Test doubles for the live interview engine. MOCKED: no real Gemini, audio or network. */
import type { InterviewEvent } from "@/types/api";

export interface FakeCallbacks {
  onmessage: (m: unknown) => void;
  onclose?: (e: { code: number; reason: string }) => void;
}

export class FakeSession {
  realtime: { audio?: unknown; text?: string; audioStreamEnd?: boolean }[] = [];
  clientContent: { turns?: unknown; turnComplete?: boolean }[] = [];
  toolResponses: unknown[] = [];
  closed = false;
  constructor(
    readonly callbacks: FakeCallbacks,
    readonly config: Record<string, unknown>,
  ) {}
  sendRealtimeInput(p: { audio?: unknown; text?: string; audioStreamEnd?: boolean }) {
    this.realtime.push(p);
  }
  sendClientContent(p: { turns?: unknown; turnComplete?: boolean }) {
    this.clientContent.push(p);
  }
  sendToolResponse(p: unknown) {
    this.toolResponses.push(p);
  }
  close() {
    this.closed = true;
  }
  /** Simulate a server message. */
  emit(m: unknown) {
    this.callbacks.onmessage(m);
  }
  drop(code = 1006) {
    this.callbacks.onclose?.({ code, reason: "network" });
  }
  get texts() {
    const rt = this.realtime.filter((r) => r.text).map((r) => r.text!);
    const cc = this.clientContent.flatMap((c) => {
      if (Array.isArray(c.turns)) {
        return c.turns.flatMap((t: unknown) => {
          const turn = t as { parts?: { text?: string }[] };
          return Array.isArray(turn?.parts)
            ? turn.parts.map((p) => p?.text).filter((x): x is string => Boolean(x))
            : [];
        });
      }
      return [];
    });
    return [...rt, ...cc];
  }
}

export const live = {
  sessions: [] as FakeSession[],
  tokens: 0,
  batches: [] as InterviewEvent[][],
  completes: [] as string[],
  reset() {
    this.sessions = [];
    this.tokens = 0;
    this.batches = [];
    this.completes = [];
  },
  get events(): InterviewEvent[] {
    return this.batches.flat();
  },
};

export class GoogleGenAI {
  constructor(readonly opts: { apiKey: string }) {}
  live = {
    connect: async (p: { config: Record<string, unknown>; callbacks: FakeCallbacks }) => {
      const s = new FakeSession(p.callbacks, p.config);
      live.sessions.push(s);
      return s;
    },
  };
}

export const interviewsApi = {
  async liveToken() {
    live.tokens += 1;
    return {
      provider: "fake",
      token: `auth_tokens/t${live.tokens}`,
      model: "fake-live",
      api_version: "v1alpha",
      expires_at: new Date(Date.now() + 1800e3).toISOString(),
      new_session_expires_at: new Date(Date.now() + 60e3).toISOString(),
      connect_config: { responseModalities: ["AUDIO"] },
      deadline_at: null,
      server_time: new Date().toISOString(),
    };
  },
  async events(_id: string, events: InterviewEvent[]) {
    live.batches.push(events);
    return { results: [], status: "in_progress", progress: {}, remaining_seconds: 1200 };
  },
  async complete(_id: string, reason: string) {
    live.completes.push(reason);
    return {};
  },
};

export class MicCapture {
  muted = false;
  async start() {}
  stop() {}
}

export class PcmPlayer {
  played = 0;
  recordTap = { stream: {} };
  enqueue() {
    this.played += 1;
  }
  clear() {}
  get isPlaying() {
    return false;
  }
}

export function parseSampleRate() {
  return 24000;
}
