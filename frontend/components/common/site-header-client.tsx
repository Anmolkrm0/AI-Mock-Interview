import Link from "next/link";

import { cn } from "@/lib/utils";

/** The logo mark: a speech bubble with the strongest line highlighted. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={cn("size-7 shrink-0", className)}>
      <path
        d="M18 8h28a12 12 0 0 1 12 12v16a12 12 0 0 1-12 12H28l-12 10v-10.4A12 12 0 0 1 6 36V20A12 12 0 0 1 18 8z"
        fill="#16213a"
      />
      <rect x="15" y="19" width="34" height="12" rx="2" transform="skewX(-10) translate(4 0)" fill="#f5d547" />
      <rect x="15" y="36" width="20" height="4" rx="2" fill="#ffffff" fillOpacity="0.6" />
    </svg>
  );
}

/** Wordmark usable from client components (no server-only imports). */
export function Wordmark({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    <Link
      href={href}
      className={cn("flex shrink-0 items-center gap-2 whitespace-nowrap font-display text-lg font-semibold", className)}
    >
      <LogoMark />
      Mock Interview
    </Link>
  );
}
