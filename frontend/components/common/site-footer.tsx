import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface py-10 text-sm text-slate">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div>
          <p className="font-medium text-ink">Mock Interview</p>
          <p className="mt-1 text-xs text-slate">
            Practice tool operated by an individual seller in India. Scores are guidance, not a hiring decision.
          </p>
        </div>
        <nav aria-label="Legal and support links" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Link href="/pricing" className="hover:text-ink">
            Pricing
          </Link>
          <Link href="/contact" className="hover:text-ink">
            Contact
          </Link>
          <Link href="/terms" className="hover:text-ink">
            Terms of Service
          </Link>
          <Link href="/privacy" className="hover:text-ink">
            Privacy Policy
          </Link>
          <Link href="/refunds" className="hover:text-ink">
            Refund Policy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
