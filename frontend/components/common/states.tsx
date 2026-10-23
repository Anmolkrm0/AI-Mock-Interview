import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/feedback";
import { ApiError } from "@/lib/api";

export function WakingNotice() {
  return (
    <Notice tone="info" title="Starting the server">
      The server sleeps when nobody is using it and can take up to a minute to wake. This page will load on its own.
    </Notice>
  );
}

export function LoadError({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const auth = error instanceof ApiError && error.status === 401;
  return (
    <Notice
      tone="error"
      title={auth ? "Your session has ended" : "This didn't load"}
      action={
        auth ? (
          <Link
            className="font-medium underline"
            href={`/login?next=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname : "/dashboard")}`}
          >
            Sign in again
          </Link>
        ) : onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null
      }
    >
      {error.message}
      {error instanceof ApiError && error.requestId ? (
        <span className="mt-1 block text-xs text-slate">Reference: {error.requestId}</span>
      ) : null}
    </Notice>
  );
}
