"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/feedback";
import { contactApi } from "@/services/contact";
import type { AdminContactMessageItem } from "@/types/api";

function formatIST(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function MessagesView() {
  const [messages, setMessages] = useState<AdminContactMessageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [handlingId, setHandlingId] = useState<string | null>(null);

  const loadMessages = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await contactApi.listAdminMessages();
      setMessages(res.items);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load contact messages.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMessages();
  }, []);

  const handleMarkHandled = async (id: string) => {
    try {
      setHandlingId(id);
      await contactApi.handleAdminMessage(id);
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, handled: true } : m))
      );
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to mark message as handled.");
    } finally {
      setHandlingId(null);
    }
  };

  if (loading && messages.length === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  if (error && messages.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-surface p-6 text-center">
        <p className="text-sm text-signal">{error}</p>
        <Button size="sm" variant="secondary" className="mt-4" onClick={() => void loadMessages()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Inquiries & Feedback</h2>
          <p className="text-sm text-slate">Direct messages submitted through the contact page.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void loadMessages()}>
          Refresh
        </Button>
      </div>

      {messages.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface p-12 text-center text-slate">
          No contact messages received yet.
        </div>
      ) : (
        <div className="space-y-4">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`rounded-lg border p-5 transition-colors ${
                m.handled ? "border-line bg-surface/50 opacity-80" : "border-line-strong bg-surface"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-ink">{m.name}</span>
                  <a
                    href={`mailto:${m.email}`}
                    className="text-sm text-slate hover:text-ink hover:underline"
                  >
                    {m.email}
                  </a>
                  {m.handled ? (
                    <Badge tone="neutral">Handled</Badge>
                  ) : (
                    <Badge tone="signal">New</Badge>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-slate">{formatIST(m.created_at)}</span>
                  {!m.handled && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={handlingId === m.id}
                      onClick={() => void handleMarkHandled(m.id)}
                    >
                      Mark handled
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink">{m.message}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
