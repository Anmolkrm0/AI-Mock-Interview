import Link from "next/link";

import { Wordmark } from "@/components/common/site-header-client";
import { buttonVariants } from "@/components/ui/button";
import { getSupabaseServer } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export { Wordmark };

export async function SiteHeader() {
  let signedIn = false;
  let isGuest = false;
  try {
    const supabase = await getSupabaseServer();
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
    isGuest = Boolean(data?.claims?.is_anonymous);
  } catch {
    signedIn = false;
  }
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-5 py-5 sm:px-8">
      <Wordmark />
      <nav aria-label="Account" className="flex items-center gap-2">
        {signedIn && !isGuest ? (
          <Link href="/dashboard" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Your interviews
          </Link>
        ) : (
          <>
            <Link href="/login" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "hidden sm:inline-flex")}>
              Sign in
            </Link>
            <Link href="/signup" className={buttonVariants({ variant: "secondary", size: "sm" })}>
              Create account
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
