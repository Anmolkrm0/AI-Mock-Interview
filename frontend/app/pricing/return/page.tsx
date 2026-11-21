"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { AppHeader } from "@/components/common/app-header";
import { SiteFooter } from "@/components/common/site-footer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { billingApi } from "@/services/billing";
import type { OrderConfirmOut } from "@/types/api";
import { recallCheckout, trackOnce } from "@/lib/analytics";

export default function PricingReturnPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-paper">
          <AppHeader />
          <div className="mx-auto max-w-xl px-5 py-24 text-center">
            <Skeleton className="mx-auto h-12 w-12 rounded-full" />
            <Skeleton className="mx-auto mt-4 h-6 w-48" />
          </div>
        </div>
      }
    >
      <ReturnContent />
    </Suspense>
  );
}

function ReturnContent() {
  const searchParams = useSearchParams();
  const orderId = searchParams.get("order_id");

  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<OrderConfirmOut | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!orderId) {
      setError("No order ID provided.");
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const res = await billingApi.confirmOrder(orderId);
      setResult(res);
      const item = recallCheckout(orderId);
      if (res.status === "paid") {
        trackOnce(`purchase_${orderId}`, "purchase", {
          transaction_id: orderId,
          currency: "INR",
          value: item?.price ?? 0,
          credits: res.credits,
          ...(item ? { items: [item] } : {}),
        });
      } else {
        trackOnce(`payment_not_completed_${orderId}`, "payment_not_completed", { status: res.status });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to verify payment status.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void confirm();
  }, [orderId]);

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <AppHeader />

      <main id="main" className="flex flex-1 items-center justify-center px-5 py-16 sm:px-8">
        <div className="w-full max-w-md rounded-xl border border-line bg-surface p-8 text-center shadow-xs">
          {loading ? (
            <div className="space-y-4">
              <div className="mx-auto size-12 animate-spin rounded-full border-4 border-ink border-t-transparent" />
              <h1 className="text-xl font-semibold text-ink">Verifying payment…</h1>
              <p className="text-sm text-slate">Please wait while we confirm your payment with Cashfree.</p>
            </div>
          ) : error ? (
            <div className="space-y-4">
              <XCircle className="mx-auto size-12 text-signal" />
              <h1 className="text-xl font-semibold text-ink">Verification Failed</h1>
              <p className="text-sm text-slate">{error}</p>
              <div className="pt-4 flex flex-col gap-2">
                <Button onClick={() => void confirm()} variant="primary" className="w-full">
                  Retry verification
                </Button>
                <Link
                  href="/pricing"
                  className="block rounded-md border border-line py-2 text-sm font-medium text-slate hover:bg-paper"
                >
                  Return to Pricing
                </Link>
              </div>
            </div>
          ) : result?.status === "paid" ? (
            <div className="space-y-4">
              <CheckCircle2 className="mx-auto size-14 text-emerald-600 dark:text-emerald-400" />
              <h1 className="text-2xl font-semibold text-ink">Payment Successful!</h1>
              <p className="text-sm text-slate">
                Your credits have been added to your account.
              </p>

              <div className="my-6 rounded-lg border border-line bg-paper p-4">
                <p className="text-xs font-medium uppercase text-slate">New Credit Balance</p>
                <p className="mt-1 text-3xl font-semibold text-ink">{result.balance}</p>
                <p className="text-xs text-slate">
                  +{result.credits} credits added
                </p>
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <Link
                  href="/interview/setup"
                  className="block w-full rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-ink-soft"
                >
                  Start an interview
                </Link>
                <Link
                  href="/dashboard"
                  className="block rounded-md border border-line py-2 text-sm font-medium text-slate hover:bg-paper"
                >
                  Go to Dashboard
                </Link>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <XCircle className="mx-auto size-12 text-signal" />
              <h1 className="text-xl font-semibold text-ink">
                {result?.status === "failed" ? "Payment failed" : result?.status === "expired" ? "Payment expired" : "Payment not completed"}
              </h1>
              <p className="text-sm text-slate">
                The payment was not completed or has expired. No credits were added. If money left your account, contact us and we will refund it within 5–7 working days.
              </p>
              <div className="pt-4 flex flex-col gap-2">
                <Link
                  href="/pricing"
                  className="block w-full rounded-md bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink-soft"
                >
                  Try Again
                </Link>
                <Link
                  href="/contact"
                  className="block rounded-md border border-line py-2 text-sm font-medium text-slate hover:bg-paper"
                >
                  Contact Support
                </Link>
              </div>
            </div>
          )}
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
