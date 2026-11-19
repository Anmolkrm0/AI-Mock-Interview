"use client";

import { api } from "@/lib/api";
import type {
  AdminBillingStatsOut,
  BillingBalanceOut,
  BillingPackagesOut,
  OrderConfirmOut,
  OrderCreateOut,
} from "@/types/api";

export const billingApi = {
  getPackages() {
    return api<BillingPackagesOut>("/billing/packages", { method: "GET", public: true });
  },
  getBalance() {
    return api<BillingBalanceOut>("/billing/balance", { method: "GET" });
  },
  createOrder(packageCode: string) {
    return api<OrderCreateOut>("/billing/orders", {
      method: "POST",
      body: { package_code: packageCode },
    });
  },
  confirmOrder(orderId: string) {
    return api<OrderConfirmOut>(`/billing/orders/${orderId}/confirm`, {
      method: "POST",
    });
  },
  getAdminStats() {
    return api<AdminBillingStatsOut>("/admin/billing/stats", { method: "GET" });
  },
  grantCredits(email: string, credits: number, note?: string) {
    return api<{ status: string; user_id: string; credits_granted: number; balance: number }>(
      "/admin/billing/grant",
      {
        method: "POST",
        body: { email, credits, note },
      }
    );
  },
};
