/**
 * Recording size planning. Supabase Free caps a single file at 50 MB, so the
 * bitrate is chosen up front from the interview length. Nothing is ever
 * truncated silently: if a recording still grows past the cap, the live page
 * stops the recorder and tells the user.
 */

export const AUDIO_BPS = 32_000; // Opus speech quality
const MIN_VIDEO_BPS = 90_000;
const MAX_VIDEO_BPS = 600_000;
const SAFETY = 0.9; // container overhead and bitrate overshoot
const OVERRUN_SECONDS = 180; // the grace period after the timer

export interface RecordingPlan {
  mode: "video" | "audio" | "none";
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  estimatedBytes: number;
  fits: boolean;
  quality: "good" | "reduced" | "low" | null;
}

export function planRecording(
  mode: "video" | "audio" | "none",
  durationMinutes: number,
  maxBytes: number,
): RecordingPlan {
  const seconds = durationMinutes * 60 + OVERRUN_SECONDS;
  if (mode === "none") {
    return { mode, videoBitsPerSecond: 0, audioBitsPerSecond: 0, estimatedBytes: 0, fits: true, quality: null };
  }
  const budgetBps = (maxBytes * 8 * SAFETY) / seconds;
  if (mode === "audio") {
    const bytes = Math.round((AUDIO_BPS * seconds) / 8);
    return {
      mode,
      videoBitsPerSecond: 0,
      audioBitsPerSecond: AUDIO_BPS,
      estimatedBytes: bytes,
      fits: AUDIO_BPS <= budgetBps,
      quality: "good",
    };
  }
  const video = Math.min(MAX_VIDEO_BPS, Math.floor(budgetBps - AUDIO_BPS));
  const fits = video >= MIN_VIDEO_BPS;
  const bytes = Math.round(((Math.max(video, MIN_VIDEO_BPS) + AUDIO_BPS) * seconds) / 8);
  const quality = video >= 300_000 ? "good" : video >= 150_000 ? "reduced" : "low";
  return {
    mode,
    videoBitsPerSecond: Math.max(video, MIN_VIDEO_BPS),
    audioBitsPerSecond: AUDIO_BPS,
    estimatedBytes: bytes,
    fits,
    quality,
  };
}

/** Pick a MediaRecorder container the browser supports. */
export function pickMimeType(mode: "video" | "audio"): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates =
    mode === "video"
      ? ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm", "video/mp4"]
      : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}
