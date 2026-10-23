"use client";

import { ApiError } from "@/lib/api";
import { interviewsApi } from "@/services/interviews";
import type { EventBatchOut, InterviewEvent } from "@/types/api";

/**
 * Durable, ordered delivery of interview events to the backend.
 *
 * Events are written to localStorage before sending, so a crash or refresh
 * doesn't lose answers. Every event has a client id, so re-sending after an
 * uncertain failure is safe (the backend de-duplicates). A batch rejected for
 * a non-retryable reason is retried one event at a time, and only the events
 * the server refuses are dropped.
 */
export class EventQueue {
  private queue: InterviewEvent[] = [];
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly storageKey: string;
  onResult?: (result: EventBatchOut) => void;
  onDropped?: (event: InterviewEvent, error: ApiError) => void;

  constructor(private readonly interviewId: string) {
    this.storageKey = `mi-events-${interviewId}`;
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey) ?? "[]") as InterviewEvent[];
      if (Array.isArray(saved)) this.queue = saved;
    } catch {
      this.queue = [];
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  private persist() {
    try {
      if (this.queue.length) localStorage.setItem(this.storageKey, JSON.stringify(this.queue));
      else localStorage.removeItem(this.storageKey);
    } catch {
      /* storage full or disabled: delivery still works in memory */
    }
  }

  push(event: InterviewEvent, { immediate = false } = {}) {
    this.queue.push(event);
    this.persist();
    if (immediate) void this.flush();
    else this.schedule();
  }

  private schedule(delay = 1200) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** Send everything pending. Resolves when the queue is empty or delivery has to wait. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.run().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.queue.length) {
      const batch = this.queue.slice(0, 50);
      try {
        const result = await interviewsApi.events(this.interviewId, batch);
        this.queue.splice(0, batch.length);
        this.persist();
        failures = 0;
        this.onResult?.(result);
      } catch (e) {
        const error = e instanceof ApiError ? e : null;
        if (error && !error.retryable && error.status >= 400 && error.status < 500 && error.status !== 401) {
          const stalled = await this.sendIndividually(batch);
          if (!stalled) continue;
          this.schedule(5000);
          return;
        }
        failures += 1;
        if (failures >= 4) {
          this.schedule(5000 * failures);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** failures));
      }
    }
  }

  /** Returns true if delivery stalled on a transient error. */
  private async sendIndividually(batch: InterviewEvent[]): Promise<boolean> {
    for (const event of batch) {
      try {
        const result = await interviewsApi.events(this.interviewId, [event]);
        this.onResult?.(result);
      } catch (e) {
        if (e instanceof ApiError && !e.retryable) {
          this.onDropped?.(event, e);
        } else {
          return true; // transient: keep the rest queued for the next flush
        }
      }
      this.queue = this.queue.filter((q) => q.client_event_id !== event.client_event_id);
      this.persist();
    }
    return false;
  }
}
