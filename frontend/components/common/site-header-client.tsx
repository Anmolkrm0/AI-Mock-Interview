import Link from "next/link";

import { cn } from "@/lib/utils";

/** Wordmark usable from client components (no server-only imports). */
export function Wordmark({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2 font-display text-lg font-semibold", className)}>
      <span aria-hidden className="grid size-7 place-items-center rounded-sm bg-ink text-[13px] font-bold text-mark">
        AI
      </span>
      Mock Interview
    </Link>
  );
}
