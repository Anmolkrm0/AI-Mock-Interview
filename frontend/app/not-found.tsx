import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-5">
      <h1 className="text-4xl font-semibold">This page doesn&apos;t exist</h1>
      <p className="mt-3 text-slate">The link may be broken, or the interview may belong to a different account.</p>
      <Link href="/dashboard" className={buttonVariants({ className: "mt-8 w-fit" })}>
        Go to your interviews
      </Link>
    </main>
  );
}
