import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reportMock = vi.fn();
const recordingUrlMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("@/services/interviews", () => ({
  interviewsApi: {
    report: (id: string) => reportMock(id),
    adminReport: (id: string) => reportMock(id),
    recordingUrl: (id: string) => recordingUrlMock(id),
    delete: (id: string) => deleteMock(id),
  },
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseBrowser: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "test-int-1" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/interview/test-int-1/report",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));

import ReportPage from "@/app/interview/[id]/report/page";

describe("Report page recording and delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reportMock.mockResolvedValue({
      id: "test-rep-1",
      interview_id: "test-int-1",
      overall_score: 85,
      report_status: "completed",
      evidence_sufficiency: "sufficient",
      competency_scores: [],
      question_evaluations: [],
      strengths: ["Great communication"],
      improvement_areas: [],
      recommendations: [],
      summary: "Well done.",
      unevaluated_questions: [],
      job_role: "Software Engineer",
      evaluation_rigor: "standard",
      duration_minutes: 20,
      created_at: new Date().toISOString(),
      rubric: { 1: "Poor", 5: "Excellent" },
      feedback: null,
    });
  });

  it("Shows quiet text and hides Play recording button when there is no recording", async () => {
    recordingUrlMock.mockRejectedValue(new Error("Not found"));
    render(<ReportPage />);

    await waitFor(() => {
      expect(screen.getByText("No recording for this interview.")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: /play recording/i })).not.toBeInTheDocument();
  });

  it("Shows player when confirmed recording exists", async () => {
    recordingUrlMock.mockResolvedValue({
      url: "https://example.com/recording.webm",
      expires_in_seconds: 3600,
      mime_type: "video/webm",
    });
    const { container } = render(<ReportPage />);

    await waitFor(() => {
      expect(container.querySelector("video")).toBeInTheDocument();
    });
    expect(screen.queryByText("No recording for this interview.")).not.toBeInTheDocument();
  });

  it("Prompts confirm dialog with exact text when Delete interview is clicked", async () => {
    recordingUrlMock.mockRejectedValue(new Error("Not found"));
    render(<ReportPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /delete interview/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: /delete interview/i }));

    expect(
      screen.getByText("This permanently deletes the transcript, report and any recording.")
    ).toBeInTheDocument();

    deleteMock.mockResolvedValue(undefined);
    // Click the confirm button in the dialog
    const confirmBtn = screen.getAllByRole("button", { name: /delete interview/i })[1]!;
    await userEvent.click(confirmBtn);

    expect(deleteMock).toHaveBeenCalledWith("test-int-1");
  });

  it("Shows Download PDF button for permanent users and calls window.print", async () => {
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    recordingUrlMock.mockRejectedValue(new Error("Not found"));
    render(<ReportPage />);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /download pdf/i })[0]).toBeInTheDocument();
    });

    await userEvent.click(screen.getAllByRole("button", { name: /download pdf/i })[0]!);
    expect(printSpy).toHaveBeenCalled();
    printSpy.mockRestore();
  });

  it("When report is locked for guests, shows preview with score, label, highlighted quote, and locked panel with signup/login buttons, and hides Download PDF", async () => {
    reportMock.mockResolvedValue({
      id: "test-rep-guest",
      interview_id: "test-int-guest",
      overall_score: 72,
      overall_label: "Strong",
      highlighted_quote: {
        quote: "I architected the database partitioning strategy.",
        supports: "Demonstrates deep system design competency.",
      },
      locked: true,
      report_status: "completed",
      evidence_sufficiency: null,
      competency_scores: [],
      question_evaluations: [],
      strengths: [],
      improvement_areas: [],
      recommendations: [],
      summary: null,
      unevaluated_questions: [],
      job_role: "System Architect",
      evaluation_rigor: "standard",
      duration_minutes: 10,
      created_at: new Date().toISOString(),
      rubric: {},
      feedback: null,
    });

    render(<ReportPage />);

    await waitFor(() => {
      expect(screen.getByText("Unlock your full interview analysis")).toBeInTheDocument();
    });

    // Score and label are visible in preview
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText("Strong")).toBeInTheDocument();

    // Highlighted quote is visible
    expect(screen.getByText(/I architected the database partitioning strategy/i)).toBeInTheDocument();
    expect(screen.getByText(/Demonstrates deep system design competency/i)).toBeInTheDocument();

    // Locked panel buttons
    expect(screen.getByRole("link", { name: /create a free account/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /i already have an account/i })).toBeInTheDocument();

    // PDF download is hidden for guests
    expect(screen.queryByRole("button", { name: /download pdf/i })).not.toBeInTheDocument();
  });
});
