import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const feedbackMock = vi.fn(async () => ({ rating: 4 }));
const listMock = vi.fn();
const retryEvaluationMock = vi.fn(async () => ({ id: "fail-1" }));

vi.mock("@/services/interviews", () => ({
  interviewsApi: {
    feedback: (...a: unknown[]) => feedbackMock(...(a as [])),
    list: () => listMock(),
    retryEvaluation: (...a: unknown[]) => retryEvaluationMock(...(a as [])),
  },
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

import { PhoneNotice } from "@/components/common/phone-notice";
import { ChoiceGroup } from "@/components/interview/choice-group";
import { Controls, Countdown, InterviewerPresence, QuestionPanel, TypedAnswer } from "@/components/interview/live-parts";
import { SampleQuestionPreview } from "@/components/landing/sample-question";
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

  it("displays Connecting… while connecting, Interviewer is speaking while speaking, and Start speaking when listening", () => {
    const { rerender } = render(<InterviewerPresence speaking={false} listening={false} connecting={true} />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(screen.queryByText("Start speaking")).not.toBeInTheDocument();

    rerender(<InterviewerPresence speaking={true} listening={false} connecting={false} />);
    expect(screen.getByText("Interviewer is speaking")).toBeInTheDocument();

    rerender(<InterviewerPresence speaking={false} listening={true} connecting={false} />);
    expect(screen.getByText("Start speaking")).toBeInTheDocument();
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

  it("shows real status reasons and working retry button when score is missing", async () => {
    listMock.mockResolvedValue({
      items: [
        {
          id: "proc-1",
          job_role: "Frontend Dev",
          duration_minutes: 10,
          evaluation_rigor: "standard",
          status: "evaluating",
          overall_score: null,
          report_status: "pending",
          has_current_recording: false,
          created_at: "2026-10-01T10:00:00Z",
          completed_at: "2026-10-01T10:10:00Z",
        },
        {
          id: "insuf-1",
          job_role: "Backend Dev",
          duration_minutes: 20,
          evaluation_rigor: "standard",
          status: "completed",
          overall_score: null,
          report_status: "completed",
          evidence_sufficiency: "insufficient",
          has_current_recording: false,
          created_at: "2026-10-01T11:00:00Z",
          completed_at: "2026-10-01T11:20:00Z",
        },
        {
          id: "fail-1",
          job_role: "DevOps Engineer",
          duration_minutes: 30,
          evaluation_rigor: "standard",
          status: "failed",
          failure_stage: "evaluation",
          overall_score: null,
          report_status: "failed",
          has_current_recording: false,
          created_at: "2026-10-01T12:00:00Z",
          completed_at: "2026-10-01T12:30:00Z",
        },
      ],
      total: 3,
      limit: 50,
      offset: 0,
      current_recording_interview_id: null,
    });
    const { default: Dashboard } = await import("@/app/dashboard/page");
    render(<Dashboard />);

    expect(await screen.findByText("Report processing")).toBeInTheDocument();
    expect(screen.getByText("Not enough answers to score")).toBeInTheDocument();
    expect(screen.getByText(/report failed —/i)).toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: "retry" });
    await userEvent.click(retryBtn);
    await waitFor(() => expect(retryEvaluationMock).toHaveBeenCalledWith("fail-1"));
  });
});

describe("PhoneNotice", () => {
  it("renders on phone screens with coarse pointer and dismisses when clicked", async () => {
    const originalInnerWidth = window.innerWidth;
    const originalMatchMedia = window.matchMedia;

    try {
      window.innerWidth = 375;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      render(<PhoneNotice />);

      expect(
        screen.getByText("Interviews work best on a laptop with Chrome and headphones."),
      ).toBeInTheDocument();

      const btn = screen.getByRole("button", { name: /continue anyway/i });
      expect(btn).toBeInTheDocument();

      await userEvent.click(btn);

      expect(
        screen.queryByText("Interviews work best on a laptop with Chrome and headphones."),
      ).not.toBeInTheDocument();
    } finally {
      window.innerWidth = originalInnerWidth;
      window.matchMedia = originalMatchMedia;
    }
  });

  it("does not render on laptop screens (width >= 768px)", () => {
    const originalInnerWidth = window.innerWidth;
    const originalMatchMedia = window.matchMedia;

    try {
      window.innerWidth = 1024;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      render(<PhoneNotice />);
      expect(
        screen.queryByText("Interviews work best on a laptop with Chrome and headphones."),
      ).not.toBeInTheDocument();
    } finally {
      window.innerWidth = originalInnerWidth;
      window.matchMedia = originalMatchMedia;
    }
  });
});

describe("setup page", () => {
  it("defaults recording mode to audio only", async () => {
    const { default: SetupPage } = await import("@/app/interview/setup/page");
    render(<SetupPage />);
    expect(screen.getByLabelText(/audio only/i)).toBeChecked();
  });
});

describe("QuestionPanel", () => {
  it("renders 'Bonus question' when question priority is optional", () => {
    const questions = [
      {
        id: "q1",
        sequence_number: 1,
        question_text: "Core question 1",
        competency: "Coding",
        difficulty: 3,
        question_type: "technical",
        priority: "core" as const,
        time_allocation_seconds: 120,
        status: "answered" as const,
      },
      {
        id: "q2",
        sequence_number: 2,
        question_text: "Optional bonus question",
        competency: "Architecture",
        difficulty: 4,
        question_type: "technical",
        priority: "optional" as const,
        time_allocation_seconds: 120,
        status: "pending" as const,
      },
    ];

    render(<QuestionPanel questions={questions} currentIndex={1} />);
    expect(screen.getByText("Bonus question")).toBeInTheDocument();
    expect(screen.queryByText(/Question 2 of 1/i)).not.toBeInTheDocument();
  });
});

describe("SampleQuestionPreview", () => {
  it("loads a sample answer and evaluates it against the rubric", async () => {
    render(<SampleQuestionPreview />);

    expect(screen.getByText("Test one question right now")).toBeInTheDocument();
    expect(screen.getByText("Ready to evaluate")).toBeInTheDocument();

    // Click "Strong response"
    const strongBtn = screen.getByRole("button", { name: "Strong response" });
    await userEvent.click(strongBtn);

    // Evaluate
    const evalBtn = screen.getByRole("button", { name: /evaluate answer/i });
    await userEvent.click(evalBtn);

    // Should see score, verified evidence and why this score
    expect(screen.getByText("Word-for-word verified")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Strong and well-supported")).toBeInTheDocument();
  });
});

