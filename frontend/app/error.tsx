"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-5">
      <h1 className="text-4xl font-semibold">Something broke on this page</h1>
      <p className="mt-3 text-slate">
        Your interview data is saved on the server. Reload the page, or go back to your dashboard.
        {error.digest ? ` Reference: ${error.digest}` : ""}
      </p>
      <div className="mt-8 flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <Link
          href="/dashboard"
          className="inline-flex h-11 items-center rounded-md border border-line-strong px-5 font-medium"
        >
          Dashboard
        </Link>
      </div>
    </main>
  );
}
