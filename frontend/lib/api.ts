"use client";

import { env } from "@/lib/env";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import type { ApiErrorBody } from "@/types/api";

export class ApiError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  requestId?: string;
  details?: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.retryable = body.retryable;
    this.requestId = body.request_id;
    this.details = body.details;
  }
}

const NETWORK_ERROR: ApiErrorBody = {
  code: "NETWORK_ERROR",
  message: "Can't reach the server. Check your connection and try again.",
  retryable: true,
};

const COLD_START_ERROR: ApiErrorBody = {
  code: "SERVER_STARTING",
  message: "The server is waking up. This can take up to a minute on the free plan.",
  retryable: true,
};

export async function getAccessToken(): Promise<string> {
  const supabase = getSupabaseBrowser();
  const { data } = await supabase.auth.getSession();
  let session = data.session;
  // Refresh a token that expires within a minute so long uploads don't fail midway.
  if (session && session.expires_at && session.expires_at * 1000 - Date.now() < 60_000) {
    const refreshed = await supabase.auth.refreshSession();
    session = refreshed.data.session;
  }
  if (!session) {
    throw new ApiError(401, { code: "AUTH_REQUIRED", message: "Sign in to continue.", retryable: false });
  }
  return session.access_token;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  form?: FormData;
  idempotencyKey?: string;
  timeoutMs?: number;
  /** Retries for transient failures (network, 502/503/504 from a cold start). */
  retries?: number;
  signal?: AbortSignal;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!env.apiUrl) {
    throw new ApiError(0, {
      code: "CONFIGURATION_ERROR",
      message: "NEXT_PUBLIC_API_URL is not set. Add it to frontend/.env.local.",
      retryable: false,
    });
  }
  const { method = "GET", retries = method === "GET" ? 2 : 0, timeoutMs = 30_000 } = options;
  let attempt = 0;
  for (;;) {
    const token = await getAccessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    let response: Response;
    try {
      response = await fetch(`${env.apiUrl}/api/v1${path}`, {
        method,
        headers,
        body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch {
      clearTimeout(timer);
      if (options.signal?.aborted) throw new ApiError(0, { code: "ABORTED", message: "Cancelled.", retryable: false });
      if (attempt < retries) {
        attempt += 1;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new ApiError(0, NETWORK_ERROR);
    }
    clearTimeout(timer);

    if (response.status === 204) return undefined as T;
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.ok) return payload as T;

    const body = (payload as { error?: ApiErrorBody } | null)?.error;
    // Render's proxy answers 502/503 without our JSON while the free instance boots.
    const coldStart = !body && [502, 503, 504].includes(response.status);
    const error = new ApiError(response.status, body ?? (coldStart ? COLD_START_ERROR : NETWORK_ERROR));
    if ((coldStart || error.code === "AUTH_KEYS_UNAVAILABLE") && attempt < retries) {
      attempt += 1;
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    throw error;
  }
}

/** Unauthenticated health probe, used to wake a sleeping Render instance. */
export async function pingBackend(timeoutMs = 60_000): Promise<boolean> {
  if (!env.apiUrl) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${env.apiUrl}/api/v1/health`, { cache: "no-store" });
      if (r.ok) return true;
    } catch {
      // keep waiting
    }
    await sleep(3000);
  }
  return false;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}
