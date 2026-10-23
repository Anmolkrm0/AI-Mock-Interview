import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const feedbackMock = vi.fn(async () => ({ rating: 4 }));
const listMock = vi.fn();

vi.mock("@/services/interviews", () => ({
  interviewsApi: { feedback: (...a: unknown[]) => feedbackMock(...(a as [])), list: () => listMock() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
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
  getSupabaseBrowser: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { ChoiceGroup } from "@/components/interview/choice-group";
import { Controls, Countdown, TypedAnswer } from "@/components/interview/live-parts";
import { FeedbackForm } from "@/components/report/feedback-form";

describe("ChoiceGroup (duration and rigor)", () => {
  it("selects with mouse and keyboard", async () => {
    const onChange = vi.fn();
    render(
      <ChoiceGroup
        name="duration"
        legend="Interview length"
        value={20}
        onChange={onChange}
        choices={[10, 20, 30, 45].map((d) => ({ value: d, label: `${d} minutes` }))}
      />,
    );
    expect(screen.getByLabelText("20 minutes")).toBeChecked();
    await userEvent.click(screen.getByText("45 minutes"));
    expect(onChange).toHaveBeenCalledWith(45);
    screen.getByLabelText("20 minutes").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith(30);
  });
});

describe("live interview controls", () => {
  it("disables skip and retake when not allowed", () => {
    render(
      <Controls
        disabled={false}
        inputMode="voice"
        canSkip={false}
        canRetake={false}
        onToggleText={vi.fn()}
        onSkip={vi.fn()}
        onRetake={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /skip question/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /retake answer/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /type an answer/i })).toBeEnabled();
  });

  it("disables everything while disconnected", () => {
    render(
      <Controls
        disabled
        inputMode="voice"
        canSkip
        canRetake
        onToggleText={vi.fn()}
        onSkip={vi.fn()}
        onRetake={vi.fn()}
      />,
    );
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
  });

  it("calls handlers", async () => {
    const onSkip = vi.fn();
    const onRetake = vi.fn();
    render(
      <Controls
        disabled={false}
        inputMode="text"
        canSkip
        canRetake
        onToggleText={vi.fn()}
        onSkip={onSkip}
        onRetake={onRetake}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /skip question/i }));
    await userEvent.click(screen.getByRole("button", { name: /retake answer/i }));
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onRetake).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /answer by voice/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("submits typed answers with Enter and keeps Shift+Enter for new lines", async () => {
    const onSubmit = vi.fn(() => true);
    render(<TypedAnswer disabled={false} onSubmit={onSubmit} />);
    const box = screen.getByLabelText("Your answer");
    await userEvent.type(box, "First line{Shift>}{Enter}{/Shift}second");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.type(box, "{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("First line\nsecond");
    expect(box).toHaveValue("");
  });

  it("counts down and flags the last two minutes", async () => {
    let remaining = 125;
    render(<Countdown getRemaining={() => remaining} />);
    expect(screen.getByRole("timer")).toHaveTextContent("2:05");
    remaining = 90;
    await waitFor(() => expect(screen.getByRole("timer")).toHaveTextContent("1:30"));
    expect(screen.getByRole("timer").className).toMatch(/text-signal/);
  });
});

describe("feedback form", () => {
  it("requires a rating, then submits", async () => {
    render(<FeedbackForm interviewId="i1" initial={null} />);
    await userEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/rating/);
    await userEvent.click(screen.getByLabelText(/4 out of 5/));
    await userEvent.type(screen.getByLabelText(/improve/), "Great questions");
    await userEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    await waitFor(() => expect(feedbackMock).toHaveBeenCalledWith("i1", 4, "Great questions"));
    expect(screen.getByRole("button", { name: /feedback sent/i })).toBeDisabled();
  });
});

describe("dashboard", () => {
  it("shows the empty state for a new account", async () => {
    listMock.mockResolvedValueOnce({ items: [], total: 0, limit: 50, offset: 0, current_recording_interview_id: null });
    const { default: Dashboard } = await import("@/app/dashboard/page");
    render(<Dashboard />);
    expect(
      await screen.findByText("No interviews yet. Start your first mock interview to track your progress."),
    ).toBeInTheDocument();
  });

  it("shows history with scores and report links", async () => {
    listMock.mockResolvedValueOnce({
      items: [
        {
          id: "a",
          job_role: "Data Analyst",
          duration_minutes: 20,
          evaluation_rigor: "standard",
          status: "completed",
          overall_score: 72.4,
          report_status: "completed",
          has_current_recording: true,
          created_at: "2026-10-01T10:00:00Z",
          completed_at: "2026-10-01T10:20:00Z",
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      current_recording_interview_id: "a",
    });
    const { default: Dashboard } = await import("@/app/dashboard/page");
    render(<Dashboard />);
    expect(await screen.findByText("Data Analyst")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View report" })).toHaveAttribute("href", "/interview/a/report");
    expect(screen.getByText(/latest recording/i)).toBeInTheDocument();
  });
});
