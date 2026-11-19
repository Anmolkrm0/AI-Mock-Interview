"use client";

import { LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Wordmark } from "@/components/common/site-header-client";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { AdminMeOut } from "@/types/api";

const baseLinks = [
  { href: "/dashboard", label: "Interviews" },
  { href: "/settings", label: "Settings" },
];

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [isAdmin, setIsAdmin] = useState(() => {
    try {
      return typeof window !== "undefined" && sessionStorage.getItem("ai_mock_is_admin") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let active = true;
    const supabase = getSupabaseBrowser();
    if (typeof supabase?.auth?.getSession === "function") {
      supabase.auth.getSession().then(({ data }) => {
        if (!active) return;
        setIsAnonymous(Boolean(data?.session?.user?.is_anonymous));
      });
    }
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    try {
      const cached = sessionStorage.getItem("ai_mock_is_admin");
      if (cached === "true") {
        return;
      }
    } catch {
      // Ignore storage errors
    }

    api<AdminMeOut>("/admin/me", { retries: 0 })
      .then((data) => {
        if (!active) return;
        const admin = Boolean(data?.admin);
        setIsAdmin(admin);
        try {
          sessionStorage.setItem("ai_mock_is_admin", admin ? "true" : "false");
        } catch {}
      })
      .catch(() => {
        if (!active) return;
        setIsAdmin(false);
        try {
          sessionStorage.setItem("ai_mock_is_admin", "false");
        } catch {}
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!isAnonymous) {
      api<{ balance: number; is_guest: boolean }>("/billing/balance", { retries: 0 })
        .then((data) => {
          if (!active) return;
          if (!data.is_guest) {
            setCredits(data.balance);
          }
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [isAnonymous, pathname]);

  const links = isAdmin
    ? [...baseLinks, { href: "/admin", label: "Admin" }]
    : baseLinks;

  async function signOut() {
    setSigningOut(true);
    try {
      sessionStorage.removeItem("ai_mock_is_admin");
    } catch {}
    await getSupabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5 sm:px-8">
        <Wordmark />
        <nav aria-label="Main" className="flex items-center gap-1">
          {isAnonymous ? (
            <Link
              href={`/signup?next=${encodeURIComponent(pathname)}`}
              className="inline-flex min-h-[44px] items-center rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
            >
              Create free account
            </Link>
          ) : (
            <>
              {credits !== null && (
                <Link
                  href="/pricing"
                  className="mr-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1 text-xs font-medium text-ink transition-colors hover:border-slate hover:bg-surface"
                  title="Your interview credits. Click to buy more."
                >
                  <span className="font-semibold text-accent">{credits}</span>
                  <span className="text-slate">{credits === 1 ? "credit" : "credits"}</span>
                </Link>
              )}
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  aria-current={pathname.startsWith(l.href) ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-[44px] items-center rounded-sm px-3 py-2 text-sm font-medium text-slate hover:text-ink",
                    pathname.startsWith(l.href) && "text-ink underline decoration-2 underline-offset-[10px]",
                  )}
                >
                  {l.label}
                </Link>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={signOut}
                loading={signingOut}
                aria-label="Sign out"
                className="min-h-[44px] min-w-[44px]"
              >
                {!signingOut && <LogOut />}
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
