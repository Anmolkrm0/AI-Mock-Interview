import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    status: number;
    code: string;
    retryable: boolean;
    constructor(status: number, body: { code: string; message: string; retryable?: boolean }) {
      super(body.message);
      this.status = status;
      this.code = body.code;
      this.retryable = body.retryable ?? false;
    }
  }
  return {
    api: (...args: unknown[]) => apiMock(...args),
    ApiError,
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/feedback",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowser: () => ({ auth: { signOut: vi.fn(), getUser: async () => ({ data: { user: null } }) } }),
}));

import AdminFeedbackPage from "@/app/admin/feedback/page";
import { ApiError } from "@/lib/api";

describe("AdminFeedbackPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders summary and table rows from mocked API", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/admin/feedback/summary") {
        return Promise.resolve({
          total_responses: 2,
          average_rating: 4.5,
          rating_counts: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 },
          last_7_days: 2,
          with_comments: 1,
        });
      }
      if (path.startsWith("/admin/feedback?")) {
        return Promise.resolve({
          items: [
            {
              submitted_at: "2026-10-23T10:00:00Z",
              user_email: "test@example.com",
              rating: 5,
              comments: "Great mock interview!",
              interview_id: "int-123",
              job_role: "Software Engineer",
              duration_minutes: 20,
              evaluation_rigor: "standard",
              overall_score: 88,
            },
            {
              submitted_at: "2026-10-22T08:00:00Z",
              user_email: null,
              rating: 4,
              comments: null,
              interview_id: "int-456",
              job_role: "Product Manager",
              duration_minutes: 30,
              evaluation_rigor: "target_bar",
              overall_score: null,
            },
          ],
          total: 2,
        });
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    render(<AdminFeedbackPage />);

    expect(screen.getByText("User Feedback")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Software Engineer")).toBeInTheDocument();
    });

    expect(screen.getByText("test@example.com")).toBeInTheDocument();
    expect(screen.getByText("Great mock interview!")).toBeInTheDocument();
    expect(screen.getByText("Product Manager")).toBeInTheDocument();
    expect(screen.getByText("★ 5")).toBeInTheDocument();
    expect(screen.getByText("★ 4")).toBeInTheDocument();
    expect(screen.getByText("88/100")).toBeInTheDocument();

    // Verify there is NO link to /interview/int-123/report
    expect(screen.queryByRole("link", { name: /view report/i })).not.toBeInTheDocument();
    const links = screen.getAllByRole("link");
    for (const link of links) {
      expect(link.getAttribute("href")).not.toContain("/report");
    }
  });

  it("shows 'This page isn't available.' on 404 response", async () => {
    apiMock.mockImplementation(() => {
      return Promise.reject(new ApiError(404, { code: "NOT_FOUND", message: "Not found", retryable: false }));
    });

    render(<AdminFeedbackPage />);

    await waitFor(() => {
      expect(screen.getByText("This page isn't available.")).toBeInTheDocument();
    });
  });

  it("shows empty state when no feedback exists", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/admin/feedback/summary") {
        return Promise.resolve({
          total_responses: 0,
          average_rating: 0,
          rating_counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
          last_7_days: 0,
          with_comments: 0,
        });
      }
      return Promise.resolve({ items: [], total: 0 });
    });

    render(<AdminFeedbackPage />);

    await waitFor(() => {
      expect(screen.getByText("No feedback yet.")).toBeInTheDocument();
    });
  });
});
