"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/field";
import { billingApi } from "@/services/billing";
import type { AdminBillingStatsOut } from "@/types/api";

function formatIST(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function PaymentsView() {
  const [stats, setStats] = useState<AdminBillingStatsOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Grant form state
  const [grantEmail, setGrantEmail] = useState("");
  const [grantCredits, setGrantCredits] = useState("1");
  const [grantNote, setGrantNote] = useState("");
  const [granting, setGranting] = useState(false);
  const [grantMsg, setGrantMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const loadStats = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await billingApi.getAdminStats();
      setStats(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load payment statistics.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStats();
  }, []);

  const handleGrant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!grantEmail.trim()) return;
    const creditsNum = parseInt(grantCredits, 10);
    if (isNaN(creditsNum) || creditsNum <= 0) return;

    try {
      setGranting(true);
      setGrantMsg(null);
      const res = await billingApi.grantCredits(grantEmail.trim(), creditsNum, grantNote.trim() || undefined);
      setGrantMsg({
        text: `Successfully granted ${res.credits_granted} credits. User now has ${res.balance} credits.`,
        ok: true,
      });
      setGrantEmail("");
      setGrantCredits("1");
      setGrantNote("");
      void loadStats();
    } catch (err: unknown) {
      setGrantMsg({
        text: err instanceof Error ? err.message : "Failed to grant credits.",
        ok: false,
      });
    } finally {
      setGranting(false);
    }
  };

  if (loading && !stats) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="rounded-lg border border-line bg-surface p-6 text-center">
        <p className="text-sm text-signal">{error}</p>
        <Button size="sm" variant="secondary" className="mt-4" onClick={() => void loadStats()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Revenue cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-line bg-surface p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-slate">Revenue Today (IST)</p>
          <p className="mt-2 text-2xl font-semibold text-ink">₹{stats?.revenue_today_inr.toLocaleString("en-IN")}</p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-slate">Revenue Last 30 Days</p>
          <p className="mt-2 text-2xl font-semibold text-ink">₹{stats?.revenue_30d_inr.toLocaleString("en-IN")}</p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-slate">Total Revenue (All Time)</p>
          <p className="mt-2 text-2xl font-semibold text-ink">₹{stats?.total_revenue_inr.toLocaleString("en-IN")}</p>
        </div>
      </div>

      {/* Grant Credits Box */}
      <div className="rounded-lg border border-line bg-surface p-6">
        <h2 className="text-lg font-semibold text-ink">Grant Interview Credits</h2>
        <p className="mt-1 text-sm text-slate">
          Directly allocate credits to a candidate account for support, refunds, or manual promotion.
        </p>

        <form onSubmit={handleGrant} className="mt-5 grid gap-4 sm:grid-cols-4 sm:items-end">
          <div className="sm:col-span-2">
            <Label htmlFor="grant-email">Candidate Email or User ID</Label>
            <Input
              id="grant-email"
              type="text"
              required
              placeholder="user@example.com or UUID"
              value={grantEmail}
              onChange={(e) => setGrantEmail(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="grant-credits">Credits</Label>
            <Input
              id="grant-credits"
              type="number"
              min="1"
              max="100"
              required
              value={grantCredits}
              onChange={(e) => setGrantCredits(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Button type="submit" loading={granting} className="w-full">
              Grant credits
            </Button>
          </div>
          <div className="sm:col-span-4">
            <Label htmlFor="grant-note">Reason / Note (optional)</Label>
            <Input
              id="grant-note"
              type="text"
              placeholder="e.g. VIP test pass or payment resolution"
              value={grantNote}
              onChange={(e) => setGrantNote(e.target.value)}
              className="mt-1"
            />
          </div>
        </form>

        {grantMsg && (
          <p className={`mt-3 text-sm ${grantMsg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-signal"}`}>
            {grantMsg.text}
          </p>
        )}
      </div>

      {/* Recent Payment Orders */}
      <div className="rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-6 py-4">
          <h2 className="text-lg font-semibold text-ink">Recent Orders</h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-paper/50 text-xs font-medium uppercase tracking-wider text-slate">
              <tr>
                <th className="px-6 py-3">Date (IST)</th>
                <th className="px-6 py-3">Candidate</th>
                <th className="px-6 py-3">Package</th>
                <th className="px-6 py-3">Credits</th>
                <th className="px-6 py-3">Amount</th>
                <th className="px-6 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {stats?.orders && stats.orders.length > 0 ? (
                stats.orders.map((o) => (
                  <tr key={o.id} className="hover:bg-paper/30">
                    <td className="whitespace-nowrap px-6 py-4 text-slate">{formatIST(o.created_at)}</td>
                    <td className="px-6 py-4 font-medium text-ink">{o.user_email || o.user_id.slice(0, 8) + "…"}</td>
                    <td className="px-6 py-4 uppercase text-slate">{o.package_code}</td>
                    <td className="px-6 py-4 text-ink">{o.credits}</td>
                    <td className="px-6 py-4 font-semibold text-ink">₹{o.amount_inr}</td>
                    <td className="px-6 py-4">
                      <Badge
                        tone={
                          o.status === "paid" ? "go" : o.status === "failed" ? "signal" : "wait"
                        }
                      >
                        {o.status}
                      </Badge>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-6 py-10 text-center text-slate">
                    No payment orders placed yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
