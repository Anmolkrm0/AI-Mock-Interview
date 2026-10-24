"use client";

import { api } from "@/lib/api";
import type {
  DocumentOut,
  EventBatchOut,
  InterviewDetail,
  InterviewEvent,
  InterviewOut,
  InterviewPage,
  LiveTokenOut,
  RecordingMode,
  RecordingOut,
  ReportOut,
  RoleDetection,
  StatusOut,
  UploadUrlOut,
  Duration,
  Rigor,
} from "@/types/api";

const AI_TIMEOUT = 120_000;

export const documentsApi = {
  uploadResume(file: File) {
    const form = new FormData();
    form.append("file", file);
    return api<DocumentOut>("/documents/resume", { method: "POST", form, timeoutMs: AI_TIMEOUT });
  },
  uploadJobDescription(input: { file?: File; text?: string }) {
    const form = new FormData();
    if (input.file) form.append("file", input.file);
    if (input.text) form.append("text", input.text);
    return api<DocumentOut>("/documents/job-description", { method: "POST", form, timeoutMs: AI_TIMEOUT });
  },
  retryParse(id: string) {
    return api<DocumentOut>(`/documents/${id}/parse`, { method: "POST", timeoutMs: AI_TIMEOUT });
  },
  correct(id: string, extracted_data: Record<string, unknown>) {
    return api<DocumentOut>(`/documents/${id}`, { method: "PATCH", body: { extracted_data } });
  },
  detectRoles(jobDescriptionId: string) {
    return api<RoleDetection>("/roles/detect", {
      method: "POST",
      body: { job_description_document_id: jobDescriptionId },
    });
  },
};

export interface CreateInterviewInput {
  resume_document_id: string;
  job_description_document_id: string;
  job_role: string;
  duration_minutes: Duration;
  evaluation_rigor: Rigor;
  recording_mode: RecordingMode;
  consent_given: boolean;
}

interface CachedLiveToken {
  promise: Promise<LiveTokenOut>;
  cachedAt: number;
}

const liveTokenCache = new Map<string, CachedLiveToken>();

export function prefetchLiveToken(id: string): void {
  try {
    interviewsApi.liveToken(id).catch(() => {
      liveTokenCache.delete(id);
    });
  } catch {
    /* ignore prefetch error */
  }
}

export function clearLiveTokenCache(id?: string): void {
  if (id) liveTokenCache.delete(id);
  else liveTokenCache.clear();
}

export const interviewsApi = {
  create(input: CreateInterviewInput, idempotencyKey: string) {
    return api<InterviewOut>("/interviews", { method: "POST", body: input, idempotencyKey, retries: 2 });
  },
  plan(interviewId: string) {
    return api<InterviewDetail>("/interviews/plan", {
      method: "POST",
      body: { interview_id: interviewId },
      timeoutMs: AI_TIMEOUT,
    });
  },
  list(offset = 0, limit = 20) {
    return api<InterviewPage>(`/interviews?limit=${limit}&offset=${offset}`);
  },
  get(id: string) {
    return api<InterviewDetail>(`/interviews/${id}`);
  },
  status(id: string) {
    return api<StatusOut>(`/interviews/${id}/status`);
  },
  liveToken(id: string, options?: { forceFresh?: boolean }): Promise<LiveTokenOut> {
    if (!options?.forceFresh) {
      const existing = liveTokenCache.get(id);
      if (existing) {
        return existing.promise
          .then((token) => {
            const exp = token.new_session_expires_at ? Date.parse(token.new_session_expires_at) : 0;
            if (exp > 0 && Date.now() >= exp - 5000) {
              liveTokenCache.delete(id);
              return interviewsApi.liveToken(id, { forceFresh: true });
            }
            return token;
          })
          .catch(() => {
            liveTokenCache.delete(id);
            return interviewsApi.liveToken(id, { forceFresh: true });
          });
      }
    }
    const promise = api<LiveTokenOut>(`/interviews/${id}/live-token`, { method: "POST", retries: 1 });
    liveTokenCache.set(id, { promise, cachedAt: Date.now() });
    return promise.catch((err) => {
      liveTokenCache.delete(id);
      throw err;
    });
  },
  events(id: string, events: InterviewEvent[]) {
    // Events carry client ids, so retrying is safe (the backend de-duplicates).
    return api<EventBatchOut>(`/interviews/${id}/events`, { method: "POST", body: { events }, retries: 3 });
  },
  complete(id: string, reason: "user_ended" | "time_expired" | "all_questions_done") {
    return api<InterviewOut>(`/interviews/${id}/complete`, { method: "POST", body: { reason }, retries: 3 });
  },
  cancel(id: string) {
    return api<InterviewOut>(`/interviews/${id}/cancel`, { method: "POST" });
  },
  retryEvaluation(id: string) {
    return api<InterviewOut>(`/interviews/${id}/retry-evaluation`, { method: "POST" });
  },
  report(id: string) {
    return api<ReportOut>(`/interviews/${id}/report`);
  },
  feedback(id: string, rating: number, comments: string) {
    return api<{ rating: number }>(`/interviews/${id}/feedback`, {
      method: "POST",
      body: { rating, comments: comments || null },
    });
  },
  recordingUrl(id: string) {
    return api<{ url: string; expires_in_seconds: number; mime_type: string }>(`/interviews/${id}/recording-url`);
  },
};

export const recordingsApi = {
  uploadUrl(input: { interview_id: string; mime_type: string; size_bytes: number; duration_seconds: number }) {
    return api<UploadUrlOut>("/recordings/upload-url", { method: "POST", body: input, retries: 2 });
  },
  confirm(uploadId: string) {
    return api<RecordingOut>("/recordings/confirm", { method: "POST", body: { upload_id: uploadId }, retries: 2 });
  },
  latest() {
    return api<RecordingOut>("/recordings/latest");
  },
  deleteLatest() {
    return api<void>("/recordings/latest", { method: "DELETE" });
  },
};
