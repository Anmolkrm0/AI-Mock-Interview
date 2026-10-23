import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { escapeCell } from "@/lib/csv";

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

let currentParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useSearchParams: () => currentParams,
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

import AdminPage from "@/app/admin/page";
import { ApiError } from "@/lib/api";

const mockOverview = {
  users: {
    total: 120,
    new_in_range: 15,
    active_24h: 8,
    active_7d: 35,
    active_30d: 80,
  },
  interviews: {
    created: 150,
    started: 110,
    completed: 95,
    cancelled: 5,
    failed: 10,
    completion_rate: 86.36,
  },
  averages: {
    overall_score: 82.5,
    duration_minutes: 28.4,
    questions_answered_per_completed: 4.8,
  },
  feedback: {
    count: 42,
    average_rating: 4.6,
    rating_counts: { 1: 1, 2: 2, 3: 5, 4: 14, 5: 20 },
  },
  breakdowns: {
    by_rigor: { casual: 20, standard: 65, target_bar: 25 },
    by_duration: { "15": 25, "30": 60, "45": 15, "60": 10 },
    top_roles: [
      { role: "Backend Engineer", count: 45 },
      { role: "Product Manager", count: 30 },
    ],
  },
  daily_series: [
    {
      date: "2026-10-22",
      new_users: 5,
      interviews_started: 12,
      interviews_completed: 10,
      feedback_count: 4,
    },
    {
      date: "2026-10-23",
      new_users: 7,
      interviews_started: 15,
      interviews_completed: 14,
      feedback_count: 6,
    },
  ],
  health: {
    ai_usage: [
      {
        operation: "conduct_turn",
        model: "gemini-2.5-flash",
        calls: 540,
        failures: 2,
        avg_latency_ms: 620,
      },
    ],
    top_error_codes: [{ error_code: "RATE_LIMIT", count: 2 }],
    connection_lost: 3,
    live_connection_failed: 1,
    recording_upload_failed: 0,
    median_time_to_first_response_ms: 780,
  },
  live_now: { count: 2 },
};

const mockUsers = {
  items: [
    {
      user_id: "usr-12345",
      email: "candidate1@example.com",
      display_name: "Candidate One",
      signed_up_at: "2026-10-10T08:00:00Z",
      last_sign_in_at: "2026-10-23T10:00:00Z",
      interviews_total: 3,
      interviews_completed: 2,
      last_interview_at: "2026-10-23T11:00:00Z",
      average_score: 85.0,
      feedback_count: 2,
    },
  ],
  total: 1,
};

const mockUserDetail = {
  user_id: "usr-12345",
  email: "candidate1@example.com",
  display_name: "Candidate One",
  signed_up_at: "2026-10-10T08:00:00Z",
  last_sign_in_at: "2026-10-23T10:00:00Z",
  interviews_total: 3,
  interviews_completed: 2,
  average_score: 85.0,
  feedback_count: 2,
  interviews: [
    {
      id: "int-999",
      created_at: "2026-10-23T11:00:00Z",
      job_role: "Staff Engineer",
      duration_minutes: 30,
      evaluation_rigor: "standard",
      status: "completed",
      failure_stage: null,
      failure_code: null,
      overall_score: 88.0,
      feedback_rating: 5,
      feedback_comments: "Challenging questions!",
    },
  ],
};

const mockInterviews = {
  items: [
    {
      id: "int-999",
      created_at: "2026-10-23T11:00:00Z",
      user_id: "usr-12345",
      user_email: "candidate1@example.com",
      job_role: "Staff Engineer",
      duration_minutes: 30,
      evaluation_rigor: "standard",
      recording_mode: "browser",
      status: "completed",
      failure_stage: null,
      failure_code: null,
      questions_total: 5,
      questions_answered: 5,
      questions_skipped: 0,
      overall_score: 88.0,
      feedback_rating: 5,
    },
  ],
  total: 1,
};

describe("Admin Dashboard Page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentParams = new URLSearchParams();
  });

  it("shows 'This page isn't available.' when /admin/me fails with 404", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/admin/me") {
        return Promise.reject(new ApiError(404, { code: "NOT_FOUND", message: "Not found", retryable: false }));
      }
      return Promise.reject(new Error("Unexpected path"));
    });

    render(<AdminPage />);

    await waitFor(() => {
      expect(screen.getByText("This page isn't available.")).toBeInTheDocument();
    });
  });

  it("renders Overview tab with summary metrics and health telemetry", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/admin/me") {
        return Promise.resolve({ admin: true });
      }
      if (path.startsWith("/admin/overview")) {
        return Promise.resolve(mockOverview);
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    render(<AdminPage />);

    await waitFor(() => {
      expect(screen.getByText("Total Users")).toBeInTheDocument();
    });

    expect(screen.getByText("Platform Overview")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("Active Users")).toBeInTheDocument();
    expect(screen.getByText("86.4%")).toBeInTheDocument();
    expect(screen.getByText("83/100")).toBeInTheDocument();
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Product Manager")).toBeInTheDocument();
    expect(screen.getByText("System Health & Telemetry")).toBeInTheDocument();
    expect(screen.getByText("conduct_turn")).toBeInTheDocument();
    expect(screen.getByText("RATE_LIMIT")).toBeInTheDocument();
  });

  it("navigates to Users tab and opens Candidate Profile drawer", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/admin/me") return Promise.resolve({ admin: true });
      if (path.startsWith("/admin/overview")) return Promise.resolve(mockOverview);
      if (path.startsWith("/admin/users/usr-12345")) return Promise.resolve(mockUserDetail);
      if (path.startsWith("/admin/users")) return Promise.resolve(mockUsers);
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    render(<AdminPage />);

    await waitFor(() => {
      expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
    });

    // Click Users tab
    const usersTab = screen.getByRole("tab", { name: "Users" });
    await userEvent.click(usersTab);

    await waitFor(() => {
      expect(screen.getByText("candidate1@example.com")).toBeInTheDocument();
    });

    // Click user row to open drawer
    await userEvent.click(screen.getByText("candidate1@example.com"));

    await waitFor(() => {
      expect(screen.getByText("Candidate Profile")).toBeInTheDocument();
      expect(screen.getByText("Staff Engineer")).toBeInTheDocument();
    });

    // Verify privacy safeguard notice is rendered
    expect(screen.getByText(/Privacy Safeguard:/i)).toBeInTheDocument();

    // Verify sensitive data does not exist
    expect(screen.queryByText(/transcript/i)).not.toHaveTextContent("transcript_text");
  });

  it("navigates to Interviews tab and renders interview filters and list", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/admin/me") return Promise.resolve({ admin: true });
      if (path.startsWith("/admin/overview")) return Promise.resolve(mockOverview);
      if (path.startsWith("/admin/interviews")) return Promise.resolve(mockInterviews);
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    render(<AdminPage />);

    await waitFor(() => {
      expect(screen.getByText("Admin Dashboard")).toBeInTheDocument();
    });

    // Click Interviews tab
    const interviewsTab = screen.getByRole("tab", { name: "Interviews" });
    await userEvent.click(interviewsTab);

    await waitFor(() => {
      expect(screen.getByText("Staff Engineer")).toBeInTheDocument();
      expect(screen.getByText("5/5")).toBeInTheDocument();
      expect(screen.getByText("88/100")).toBeInTheDocument();
    });
  });
});

describe("CSV Export Formula Injection Mitigation", () => {
  it("escapes cells starting with =, +, -, @ by prefixing with single quote", () => {
    expect(escapeCell("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
    expect(escapeCell("+12345")).toBe("'+12345");
    expect(escapeCell("-50")).toBe("'-50");
    expect(escapeCell("@cmd|' /C calc'!A0")).toBe("'@cmd|' /C calc'!A0");
  });

  it("handles regular strings, null, and numbers safely", () => {
    expect(escapeCell("Normal Text")).toBe("Normal Text");
    expect(escapeCell(null)).toBe("");
    expect(escapeCell(undefined)).toBe("");
    expect(escapeCell(42)).toBe("42");
  });

  it("quotes cells containing commas, quotes, or newlines", () => {
    expect(escapeCell('Hello, "world"')).toBe('"Hello, ""world"""');
    expect(escapeCell("Line 1\nLine 2")).toBe('"Line 1\nLine 2"');
  });
});
