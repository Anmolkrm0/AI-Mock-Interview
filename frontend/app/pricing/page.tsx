"use client";

import { Check, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Script from "next/script";
import { Suspense, useEffect, useState } from "react";

import { AppHeader } from "@/components/common/app-header";
import { SiteFooter } from "@/components/common/site-footer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/feedback";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { billingApi } from "@/services/billing";
import type { BillingPackage, BillingPackagesOut } from "@/types/api";
import { packageItem, rememberCheckout, track } from "@/lib/analytics";

const DEFAULT_PACKAGES: BillingPackage[] = [
  {
    code: "single",
    name: "Single",
    credits: 1,
    amount_paise: 14900,
    price_inr: 149,
    popular: false,
    description: "1 interview · ₹149 per credit",
  },
  {
    code: "starter",
    name: "Starter",
    credits: 3,
    amount_paise: 29900,
    price_inr: 299,
    popular: false,
    description: "3 interviews · ₹100 per credit",
  },
  {
    code: "pro",
    name: "Pro",
    credits: 8,
    amount_paise: 69900,
    price_inr: 699,
    popular: true,
    description: "8 interviews · ₹87 per credit",
  },
  {
    code: "job_hunt",
    name: "Job Hunt",
    credits: 15,
    amount_paise: 119900,
    price_inr: 1199,
    popular: false,
    description: "15 interviews · ₹80 per credit, the lowest price",
  },
];

export default function PricingPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-paper">
          <AppHeader />
          <div className="mx-auto max-w-6xl px-5 py-16 text-center text-slate">Loading pricing…</div>
        </div>
      }
    >
      <PricingContent />
    </Suspense>
  );
}

function PricingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const reason = searchParams.get("reason");

  const [packages, setPackages] = useState<BillingPackage[]>(DEFAULT_PACKAGES);
  const [paymentsEnabled, setPaymentsEnabled] = useState(false);
  const [isGuest, setIsGuest] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [purchasingCode, setPurchasingCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    billingApi
      .getPackages()
      .then((data: BillingPackagesOut) => {
        if (!active) return;
        const list = data.packages && data.packages.length > 0 ? data.packages : DEFAULT_PACKAGES;
        if (data.packages && data.packages.length > 0) {
          setPackages(data.packages);
        }
        track("view_item_list", {
          item_list_id: "credit_packs",
          item_list_name: "Credit packs",
          items: list.map((p, i) => packageItem(p, i)),
        });
        setPaymentsEnabled(data.payments_enabled);
      })
      .catch(() => {});

    const supabase = getSupabaseBrowser();
    if (typeof supabase?.auth?.getSession === "function") {
      supabase.auth.getSession().then(({ data }) => {
        if (!active) return;
        const session = data?.session;
        setIsSignedIn(Boolean(session));
        setIsGuest(Boolean(session?.user?.is_anonymous));
        if (session && !session.user?.is_anonymous) {
          billingApi
            .getBalance()
            .then((b) => {
              if (active) setIsAdmin(Boolean(b.is_admin));
            })
            .catch(() => {});
        }
      });
    }

    return () => {
      active = false;
    };
  }, []);

  const handleBuy = async (pkg: BillingPackage) => {
    setError(null);
    track("select_item", { item_list_id: "credit_packs", items: [packageItem(pkg)] });
    if (!isSignedIn || isGuest) {
      router.push(`/signup?next=${encodeURIComponent("/pricing")}`);
      return;
    }

    try {
      setPurchasingCode(pkg.code);
      const res = await billingApi.createOrder(pkg.code);
      rememberCheckout(res.order_id, packageItem(pkg));
      track("begin_checkout", { currency: "INR", value: pkg.price_inr, items: [packageItem(pkg)] });

      // Verify Cashfree SDK loaded
      // @ts-expect-error Cashfree SDK global
      if (typeof window.Cashfree === "undefined") {
        setError("Payment gateway is loading. Please wait 3 seconds and try again.");
        setPurchasingCode(null);
        return;
      }

      // @ts-expect-error Cashfree SDK global
      const cashfree = window.Cashfree({
        mode: res.mode === "production" ? "production" : "sandbox",
      });

      cashfree.checkout({
        paymentSessionId: res.payment_session_id,
        redirectTarget: "_self",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to initiate payment. Please try again.");
      setPurchasingCode(null);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      {/* Cashfree JS SDK */}
      <Script src="https://sdk.cashfree.com/js/v3/cashfree.js" strategy="lazyOnload" />

      <AppHeader />

      <main id="main" className="flex-1 py-12 sm:py-16">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          {reason === "payment_required" && (
            <div className="mb-8 rounded-lg border border-line bg-surface p-4 text-center sm:p-5" role="alert">
              <p className="font-semibold text-ink">Your free interview is used.</p>
              <p className="mt-1 text-sm text-slate">
                Choose a credit pack below to continue practising with AI mock interviews.
              </p>
            </div>
          )}

          {error && (
            <div className="mb-8 rounded-lg border border-line bg-surface p-4 text-center text-sm text-signal" role="alert">
              {error}
            </div>
          )}

          <div className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-5xl">
              Simple, transparent interview credits
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-base text-slate sm:text-lg">
              No recurring monthly subscriptions. Buy interview credits when you need them and practice on your own schedule.
            </p>
          </div>

          {/* Pricing cards grid */}
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {packages.map((pkg) => (
              <div
                key={pkg.code}
                className={`relative flex flex-col justify-between rounded-xl border bg-surface p-6 transition-shadow ${
                  pkg.popular
                    ? "border-ink shadow-md ring-1 ring-ink"
                    : "border-line shadow-xs hover:border-line-strong"
                }`}
              >
                {pkg.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-ink px-3 py-1 text-xs font-semibold uppercase tracking-wider text-white">
                      <Sparkles className="size-3" /> Most popular
                    </span>
                  </div>
                )}

                <div>
                  <h2 className="text-xl font-semibold text-ink">{pkg.name}</h2>
                  <p className="mt-1 text-xs text-slate">{pkg.description}</p>

                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="text-4xl font-semibold text-ink">₹{pkg.price_inr}</span>
                    <span className="text-xs text-slate">/ one-time</span>
                  </div>

                  <div className="mt-6 space-y-3 border-t border-line pt-6 text-sm">
                    <div className="flex items-center gap-2.5">
                      <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <span className="font-medium text-ink">
                        {pkg.credits} {pkg.credits === 1 ? "credit" : "credits"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2.5 text-slate">
                      <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <span>Full voice mock interview</span>
                    </div>
                    <div className="flex items-center gap-2.5 text-slate">
                      <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <span>Rubric evaluation & feedback</span>
                    </div>
                    <div className="flex items-center gap-2.5 text-slate">
                      <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <span>Credits never expire</span>
                    </div>
                  </div>
                </div>

                <div className="mt-8">
                  {isGuest || !isSignedIn ? (
                    <Link
                      href={`/signup?next=${encodeURIComponent("/pricing")}`}
                      className="block w-full rounded-md bg-ink px-4 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-ink-soft"
                    >
                      Sign up to buy
                    </Link>
                  ) : !paymentsEnabled && !isAdmin ? (
                    <Button disabled variant="secondary" className="w-full py-2.5 text-sm font-medium">
                      Opening soon
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void handleBuy(pkg)}
                      loading={purchasingCode === pkg.code}
                      variant={pkg.popular ? "primary" : "secondary"}
                      className="w-full py-2.5 text-sm font-medium"
                    >
                      Buy {pkg.name}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Credit usage breakdown table */}
          <div className="mt-16 rounded-xl border border-line bg-surface p-6 sm:p-8">
            <h2 className="text-xl font-semibold text-ink">How interview credits work</h2>
            <p className="mt-2 text-sm text-slate">
              Credits are used when you set up an interview. If it fails to connect, is cancelled, or does not start within 30 minutes, the credits go back to your balance automatically.
            </p>

            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-lg border border-line bg-paper p-4 text-center">
                <p className="text-xs font-semibold uppercase text-slate">10 Minutes</p>
                <p className="mt-1 text-2xl font-semibold text-ink">1 Credit</p>
                <p className="mt-1 text-xs text-slate">Quick warmup</p>
              </div>
              <div className="rounded-lg border border-line bg-paper p-4 text-center">
                <p className="text-xs font-semibold uppercase text-slate">20 Minutes</p>
                <p className="mt-1 text-2xl font-semibold text-ink">2 Credits</p>
                <p className="mt-1 text-xs text-slate">Core competencies</p>
              </div>
              <div className="rounded-lg border border-line bg-paper p-4 text-center">
                <p className="text-xs font-semibold uppercase text-slate">30 Minutes</p>
                <p className="mt-1 text-2xl font-semibold text-ink">3 Credits</p>
                <p className="mt-1 text-xs text-slate">Standard interview</p>
              </div>
              <div className="rounded-lg border border-line bg-paper p-4 text-center">
                <p className="text-xs font-semibold uppercase text-slate">45 Minutes</p>
                <p className="mt-1 text-2xl font-semibold text-ink">5 Credits</p>
                <p className="mt-1 text-xs text-slate">Full in-depth round</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
