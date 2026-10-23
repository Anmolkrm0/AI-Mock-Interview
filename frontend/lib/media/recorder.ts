"use client";

import { pickMimeType, type RecordingPlan } from "@/lib/media/recording-budget";

export interface FinishedRecording {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  stoppedAtLimit: boolean;
}

/**
 * Records camera video (optional) plus a mix of the candidate's microphone and
 * the interviewer's voice. Tracks the size as it grows and stops — visibly, via
 * onLimitReached — if it would exceed the storage cap.
 */
export class InterviewRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private bytes = 0;
  private startedAt = 0;
  private stoppedAtLimit = false;
  private mixDest: MediaStreamAudioDestinationNode | null = null;
  readonly mimeType: string;

  constructor(
    private readonly plan: RecordingPlan,
    private readonly maxBytes: number,
    private readonly onSize?: (bytes: number) => void,
    private readonly onLimitReached?: () => void,
  ) {
    const mode = plan.mode === "video" ? "video" : "audio";
    this.mimeType = pickMimeType(mode) ?? "";
  }

  get supported(): boolean {
    return this.plan.mode !== "none" && !!this.mimeType;
  }

  start(ctx: AudioContext, mic: MediaStream, interviewerAudio: MediaStream, camera: MediaStream | null): void {
    if (!this.supported) return;
    this.mixDest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(mic).connect(this.mixDest);
    ctx.createMediaStreamSource(interviewerAudio).connect(this.mixDest);
    const tracks = [...this.mixDest.stream.getAudioTracks()];
    const videoTrack = camera?.getVideoTracks()[0];
    if (this.plan.mode === "video" && videoTrack) tracks.push(videoTrack);
    const stream = new MediaStream(tracks);
    const options: MediaRecorderOptions = {
      mimeType: this.mimeType,
      audioBitsPerSecond: this.plan.audioBitsPerSecond,
    };
    if (this.plan.mode === "video" && videoTrack) options.videoBitsPerSecond = this.plan.videoBitsPerSecond;
    this.recorder = new MediaRecorder(stream, options);
    this.recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      this.chunks.push(e.data);
      this.bytes += e.data.size;
      this.onSize?.(this.bytes);
      if (this.bytes >= this.maxBytes * 0.97 && this.recorder?.state === "recording") {
        this.stoppedAtLimit = true;
        this.recorder.stop();
        this.onLimitReached?.();
      }
    };
    this.startedAt = performance.now();
    this.recorder.start(5000);
  }

  get size(): number {
    return this.bytes;
  }

  async stop(): Promise<FinishedRecording | null> {
    const recorder = this.recorder;
    if (!recorder) return null;
    if (recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }
    this.recorder = null;
    if (this.chunks.length === 0) return null;
    const type = this.mimeType.split(";")[0] ?? this.mimeType;
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    return {
      blob,
      mimeType: type,
      durationSeconds: Math.max(1, Math.round((performance.now() - this.startedAt) / 1000)),
      stoppedAtLimit: this.stoppedAtLimit,
    };
  }
}

/** Hand-off of the finished recording from the live page to the processing page. */
const pending = new Map<string, FinishedRecording>();

export const pendingRecordings = {
  set(interviewId: string, rec: FinishedRecording) {
    pending.set(interviewId, rec);
  },
  get(interviewId: string) {
    return pending.get(interviewId) ?? null;
  },
  clear(interviewId: string) {
    pending.delete(interviewId);
  },
};
