import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/pricing",
  useRouter: () => ({ replace: mockReplace, push: mockPush, refresh: mockRefresh }),
  useSearchParams: () => new URLSearchParams("order_id=order_123&reason=payment_required"),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/services/billing", () => ({
  billingApi: {
    getPackages: vi.fn(async () => ({
      packages: [
        { code: "single", name: "Single", credits: 1, amount_paise: 14900, price_inr: 149, popular: false, description: "1 credit" },
        { code: "pro", name: "Pro", credits: 8, amount_paise: 69900, price_inr: 699, popular: true, description: "8 credits" },
      ],
      interview_costs: { "10": 1, "45": 5 },
      payments_enabled: true,
    })),
    getBalance: vi.fn(async () => ({
      balance: 5,
      is_guest: false,
      is_admin: false,
    })),
    createOrder: vi.fn(async (code: string) => ({
      order_id: `order_${code}`,
      cf_order_id: `cf_${code}`,
      payment_session_id: "session_123",
      mode: "sandbox",
    })),
    confirmOrder: vi.fn(async (_orderId: string) => ({
      status: "paid",
      balance: 9,
      credits: 8,
    })),
    getAdminStats: vi.fn(async () => ({
      revenue_today_inr: 149,
      revenue_30d_inr: 848,
      total_revenue_inr: 1200,
      orders: [],
    })),
  },
}));

vi.mock("@/services/contact", () => ({
  contactApi: {
    submit: vi.fn(async () => ({ status: "ok", message_id: "msg_123" })),
    listAdminMessages: vi.fn(async () => ({ items: [], total: 0 })),
    handleAdminMessage: vi.fn(async () => ({ status: "ok", message_id: "msg_123" })),
  },
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowser: () => ({
    auth: {
      getSession: async () => ({
        data: {
          session: {
            user: { id: "user_test", is_anonymous: false },
            access_token: "mock-jwt",
          },
        },
      }),
      signOut: vi.fn(),
    },
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (path === "/billing/balance") {
        return { balance: 5, is_guest: false, is_admin: false };
      }
      if (path === "/admin/me") {
        return { admin: false };
      }
      return {};
    }),
  };
});

import { StartInterviewButton } from "@/components/common/start-interview-button";
import ContactPage from "@/app/contact/page";
import PricingPage from "@/app/pricing/page";
import PricingReturnPage from "@/app/pricing/return/page";
import { AppHeader } from "@/components/common/app-header";
import { contactApi } from "@/services/contact";
import { billingApi } from "@/services/billing";

describe("Cashfree Payments & Billing Frontend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders pricing page with packages and payment required banner", async () => {
    render(<PricingPage />);
    expect(await screen.findByText(/Your free interview is used/i)).toBeInTheDocument();
    expect(await screen.findByText("Single")).toBeInTheDocument();
    expect(await screen.findByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("₹149")).toBeInTheDocument();
    expect(screen.getByText("₹699")).toBeInTheDocument();
  });

  it("initiates order creation on clicking buy button", async () => {
    render(<PricingPage />);
    const buyBtn = await screen.findByRole("button", { name: /Buy Single/i });
    expect(buyBtn).toBeInTheDocument();

    // Mock Cashfree checkout on window
    const mockCheckout = vi.fn();
    // @ts-expect-error test mock
    window.Cashfree = vi.fn(() => ({ checkout: mockCheckout }));

    await userEvent.click(buyBtn);
    expect(billingApi.createOrder).toHaveBeenCalledWith("single");
    await waitFor(() => {
      expect(mockCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ paymentSessionId: "session_123" })
      );
    });
  });

  it("confirms order on pricing return page and displays new balance", async () => {
    render(<PricingReturnPage />);
    expect(billingApi.confirmOrder).toHaveBeenCalledWith("order_123");
    expect(await screen.findByText(/Payment Successful!/i)).toBeInTheDocument();
    expect(await screen.findByText("9")).toBeInTheDocument(); // balance
    expect(screen.getByText(/Start an interview/i)).toBeInTheDocument();
  });

  it("renders contact form and submits inquiry successfully", async () => {
    render(<ContactPage />);
    expect(screen.getByRole("heading", { name: /Contact & Support/i })).toBeInTheDocument();

    const nameInput = screen.getByLabelText(/Your Name/i);
    const emailInput = screen.getByLabelText(/Email Address/i);
    const msgInput = screen.getByLabelText(/Message/i);

    await userEvent.type(nameInput, "Alice Smith");
    await userEvent.type(emailInput, "alice@example.com");
    await userEvent.type(msgInput, "Question about enterprise packages.");

    const submitBtn = screen.getByRole("button", { name: /Send message/i });
    await userEvent.click(submitBtn);

    expect(contactApi.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Alice Smith",
        email: "alice@example.com",
        message: "Question about enterprise packages.",
      })
    );
    expect(await screen.findByText(/Message Sent!/i)).toBeInTheDocument();
  });

  it("AppHeader displays credits badge for registered users", async () => {
    render(<AppHeader />);
    expect(await screen.findByText("5")).toBeInTheDocument();
    expect(await screen.findByText("credits")).toBeInTheDocument();
  });

  it("StartInterviewButton respects hintClassName", () => {
    const { container } = render(
      <StartInterviewButton hintClassName="custom-hint-color" />
    );
    expect(container).toBeInTheDocument();
  });
});
