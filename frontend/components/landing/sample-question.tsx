"use client";

import { CheckCircle2, ChevronRight, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { highlightQuotes } from "@/lib/highlight";
import { cn } from "@/lib/utils";

interface SamplePrompt {
  role: string;
  question: string;
  competency: string;
  strongAnswer: string;
  briefAnswer: string;
  strongQuotes: string[];
  briefQuotes: string[];
  strongRationale: string;
  briefRationale: string;
  strongStrengths: string[];
  briefStrengths: string[];
  strongImprovements: string[];
  briefImprovements: string[];
}

const SAMPLE_QUESTIONS: SamplePrompt[] = [
  {
    role: "Software Engineer",
    question: "Tell me about a time you had to optimize a slow system or fix a critical performance bottleneck. What was your approach?",
    competency: "System Design & Optimization",
    strongAnswer:
      "We were hitting Postgres on every catalogue request, so I added a read-through Redis cache for product details. After rollout, p95 latency dropped from 480 to 190 milliseconds, and I configured automated alerts on cache hit rate and memory pressure.",
    briefAnswer:
      "Our website was running slowly so I checked into the backend. I found some slow parts and rewrote some code to make it faster. The system improved and users stopped complaining.",
    strongQuotes: [
      "added a read-through Redis cache for product details",
      "p95 latency dropped from 480 to 190 milliseconds",
      "configured automated alerts on cache hit rate and memory pressure",
    ],
    briefQuotes: ["found some slow parts and rewrote some code"],
    strongRationale:
      "The answer identifies the root cause (excessive database hits), describes a specific technical solution (read-through Redis caching), and supports the impact with measurable metrics (p95 drop from 480ms to 190ms) along with monitoring.",
    briefRationale:
      "The response mentions rewriting code, but lacks technical specifics on what caused the bottleneck, what architecture changes were made, and measurable impact metrics.",
    strongStrengths: [
      "Quantified impact with concrete latency metrics (480ms to 190ms).",
      "Demonstrated production maturity by adding alerting and monitoring.",
    ],
    briefStrengths: ["Acknowledged user complaints and initiated an investigation."],
    strongImprovements: [
      "Briefly mention how cache invalidation was handled during catalogue updates.",
    ],
    briefImprovements: [
      "Cite specific tools, profiling steps, or technologies used.",
      "Include before-and-after numbers or percentages to substantiate the outcome.",
    ],
  },
  {
    role: "Product Manager",
    question: "Describe a product feature you prioritized that had conflicting stakeholder opinions. How did you decide what to build?",
    competency: "Prioritization & Alignment",
    strongAnswer:
      "Enterprise sales requested custom CSV exports while growth pushed for self-serve onboarding. I analyzed user drop-off data showing 42% abandonment costing $60k MRR. I scheduled onboarding redesign for the immediate sprint and negotiated a scoped 2-week export tool that satisfied 80% of enterprise prospects.",
    briefAnswer:
      "Sales wanted one thing and growth wanted another. I held a meeting where both teams explained what they wanted, and we decided to do a little bit of both so nobody was upset.",
    strongQuotes: [
      "analyzed user drop-off data showing 42% abandonment costing $60k MRR",
      "scheduled onboarding redesign for the immediate sprint",
      "negotiated a scoped 2-week export tool that satisfied 80% of enterprise prospects",
    ],
    briefQuotes: ["held a meeting where both teams explained"],
    strongRationale:
      "The answer uses data-driven prioritization with clear business trade-offs, demonstrating structured compromise without compromising core company growth.",
    briefRationale:
      "The answer resolves conflict through compromise, but lacks objective criteria, revenue or engagement metrics, and strategic rationale.",
    strongStrengths: [
      "Grounds trade-off decisions in concrete business metrics ($60k MRR drop-off).",
      "Scoped solutions iteratively instead of stalling execution.",
    ],
    briefStrengths: ["Facilitated cross-functional discussion between sales and growth."],
    strongImprovements: ["Mention how success was tracked after the onboarding redesign launched."],
    briefImprovements: [
      "Explain the framework used to evaluate competing requests (e.g. RICE, impact vs effort).",
      "Share measurable business outcomes after rollout.",
    ],
  },
  {
    role: "Leadership / Behavioral",
    question: "Can you share an example of a project where requirements shifted midway? How did you adapt your plan?",
    competency: "Adaptability & Execution",
    strongAnswer:
      "Two weeks before our planned release, new compliance regulations required immutable audit logs for all financial mutations. I deprioritized non-critical UI polish, split the audit pipeline into an async event-stream middleware, and kept our original launch date with zero audit discrepancies.",
    briefAnswer:
      "The regulations changed shortly before our launch. We had to work overtime and weekends to add the requested audit logs, but we finished on time.",
    strongQuotes: [
      "new compliance regulations required immutable audit logs",
      "deprioritized non-critical UI polish",
      "split the audit pipeline into an async event-stream middleware",
      "kept our original launch date with zero audit discrepancies",
    ],
    briefQuotes: ["work overtime and weekends to add the requested audit logs"],
    strongRationale:
      "The candidate responded to a high-impact requirement change by proactively adjusting scope and designing a clean architectural abstraction, protecting the delivery timeline.",
    briefRationale:
      "The candidate met the deadline, but relied on overtime rather than scope management, architectural trade-offs, or stakeholder negotiation.",
    strongStrengths: [
      "Made deliberate scope cuts (non-critical UI polish) to protect core delivery.",
      "Clear technical approach (async event-stream middleware).",
    ],
    briefStrengths: ["High commitment to team delivery timelines."],
    strongImprovements: [
      "Mention how the scope adjustment was communicated to executive stakeholders.",
    ],
    briefImprovements: [
      "Describe how you re-prioritized tasks instead of relying solely on extra hours.",
      "Include validation methods used to confirm compliance.",
    ],
  },
];

export function SampleQuestionPreview() {
  const [selectedRoleIndex, setSelectedRoleIndex] = useState(0);
  const [candidateText, setCandidateText] = useState("");
  const [evaluated, setEvaluated] = useState(false);

  const prompt = SAMPLE_QUESTIONS[selectedRoleIndex] ?? SAMPLE_QUESTIONS[0]!;

  function handleSelectRole(index: number) {
    setSelectedRoleIndex(index);
    setCandidateText("");
    setEvaluated(false);
  }

  function handleLoadSample(type: "strong" | "brief") {
    setCandidateText(type === "strong" ? prompt.strongAnswer : prompt.briefAnswer);
    setEvaluated(false);
  }

  function handleEvaluate() {
    if (!candidateText.trim()) return;
    setEvaluated(true);
  }

  // Dynamic evaluation: determine evidence quotes and score
  const isStrong =
    candidateText.length >= 100 &&
    (candidateText.toLowerCase().includes("redis") ||
      candidateText.toLowerCase().includes("mrr") ||
      candidateText.toLowerCase().includes("middleware") ||
      candidateText.toLowerCase().includes("latency") ||
      candidateText.toLowerCase().includes("%") ||
      candidateText.toLowerCase().includes("p95") ||
      candidateText.toLowerCase().includes("audit") ||
      candidateText.toLowerCase().includes("drop-off"));

  const score = isStrong ? 4 : candidateText.trim().length > 60 ? 3 : 2;
  const scoreLabel =
    score === 4
      ? "Strong and well-supported"
      : score === 3
        ? "Adequate with room for depth"
        : "Thin on concrete evidence";

  const quotesToHighlight = isStrong
    ? prompt.strongQuotes.filter((q) => candidateText.toLowerCase().includes(q.toLowerCase().slice(0, 15)))
    : prompt.briefQuotes.filter((q) => candidateText.toLowerCase().includes(q.toLowerCase().slice(0, 15)));

  // If candidate wrote custom text, extract phrases as evidence
  const finalQuotes =
    quotesToHighlight.length > 0
      ? quotesToHighlight
      : candidateText
          .split(/[.,;]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 15)
          .slice(0, 2);

  const segments = highlightQuotes(candidateText, finalQuotes);

  return (
    <section aria-labelledby="sample-trial-heading" className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
      <div className="max-w-2xl">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate">Try before you sign up</span>
        <h2 id="sample-trial-heading" className="mt-2 text-3xl font-semibold sm:text-4xl">
          Test one question right now
        </h2>
        <p className="mt-3 text-slate">
          Pick a role, answer the prompt, and see how the AI grades your response against an evidence-based rubric. No
          account or microphone required.
        </p>
      </div>

      <div className="mt-8 flex flex-wrap gap-2">
        {SAMPLE_QUESTIONS.map((p, i) => (
          <button
            key={p.role}
            type="button"
            onClick={() => handleSelectRole(i)}
            className={cn(
              "rounded-full px-4 py-2 text-sm font-medium transition-colors",
              selectedRoleIndex === i
                ? "bg-ink text-white"
                : "border border-line bg-surface text-slate hover:border-line-strong hover:text-ink",
            )}
          >
            {p.role}
          </button>
        ))}
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-[1.1fr_1fr]">
        {/* Question & Input Area */}
        <div className="flex flex-col justify-between rounded-lg border border-line bg-surface p-6 sm:p-7">
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs font-medium text-slate">
              <span>{prompt.competency}</span>
              <span>1 question preview</span>
            </div>
            <p className="font-display text-xl font-semibold leading-snug sm:text-2xl">{prompt.question}</p>

            <div className="pt-2">
              <label htmlFor="sample-answer-input" className="block text-sm font-medium text-slate">
                Your answer
              </label>
              <textarea
                id="sample-answer-input"
                rows={5}
                value={candidateText}
                onChange={(e) => {
                  setCandidateText(e.target.value);
                  setEvaluated(false);
                }}
                placeholder="Type your response here, or click one of the sample answers below to see how it grades…"
                className="mt-2 w-full rounded-md border border-line bg-white p-3 text-[15px] leading-relaxed text-ink placeholder:text-slate/60 focus:border-ink focus:outline-hidden"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
              <span className="text-slate">Or test a pre-written answer:</span>
              <button
                type="button"
                onClick={() => handleLoadSample("strong")}
                className="rounded-md border border-line bg-paper px-2.5 py-1 font-medium hover:border-line-strong hover:text-ink"
              >
                Strong response
              </button>
              <button
                type="button"
                onClick={() => handleLoadSample("brief")}
                className="rounded-md border border-line bg-paper px-2.5 py-1 font-medium hover:border-line-strong hover:text-ink"
              >
                Brief response
              </button>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <Button size="md" onClick={handleEvaluate} disabled={!candidateText.trim()}>
              <Sparkles className="size-4" aria-hidden /> Evaluate answer
            </Button>
            {candidateText && (
              <button
                type="button"
                onClick={() => {
                  setCandidateText("");
                  setEvaluated(false);
                }}
                className="text-sm text-slate underline hover:text-ink"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Evaluation Result Area */}
        <div className="flex flex-col justify-between rounded-lg border border-line bg-surface p-6 sm:p-7">
          {evaluated ? (
            <div className="space-y-5 animate-in fade-in duration-300">
              <div className="flex items-baseline justify-between border-b border-line pb-4">
                <div>
                  <p className="font-display text-4xl font-semibold tabular-nums">
                    {score}
                    <span className="text-lg font-normal text-slate">/5</span>
                  </p>
                  <p className="text-sm font-medium text-slate">{scoreLabel}</p>
                </div>
                <span className="rounded-full bg-go-soft px-3 py-1 text-xs font-semibold text-go">
                  Word-for-word verified
                </span>
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate">Evidence in your answer</h3>
                <blockquote className="mt-2 rounded-md bg-paper p-3 text-[14px] leading-relaxed">
                  {segments.map((s, i) =>
                    s.marked ? (
                      <mark key={i} className="mark-evidence text-ink font-medium">
                        {s.text}
                      </mark>
                    ) : (
                      <span key={i}>{s.text}</span>
                    ),
                  )}
                </blockquote>
                <p className="mt-2 text-xs text-slate">
                  Highlighted lines are evidence the score is based on.
                </p>
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate">Why this score</h3>
                <p className="mt-1 text-sm text-ink leading-relaxed">
                  {isStrong ? prompt.strongRationale : prompt.briefRationale}
                </p>
              </div>

              <div className="space-y-3 pt-2 text-sm">
                <div>
                  <h4 className="font-medium text-go">Strength:</h4>
                  <ul className="mt-1 list-disc pl-5 text-slate">
                    {(isStrong ? prompt.strongStrengths : prompt.briefStrengths).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-wait">To improve:</h4>
                  <ul className="mt-1 list-disc pl-5 text-slate">
                    {(isStrong ? prompt.strongImprovements : prompt.briefImprovements).map((imp, i) => (
                      <li key={i}>{imp}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="rounded-md border border-line bg-paper p-4 pt-3">
                <p className="font-medium text-sm">Want to rehearse a full interview?</p>
                <p className="mt-1 text-xs text-slate">
                  Upload your actual resume and job description to practice with spoken questions and follow-ups.
                </p>
                <div className="mt-3">
                  <Link href="/interview/setup" className={cn(buttonVariants({ size: "sm" }), "w-full justify-center")}>
                    Start full interview <ChevronRight className="size-4" />
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center py-12 px-4">
              <div className="flex size-12 items-center justify-center rounded-full bg-paper text-slate">
                <Sparkles className="size-6" />
              </div>
              <h3 className="mt-4 font-display text-lg font-semibold">Ready to evaluate</h3>
              <p className="mt-2 max-w-sm text-sm text-slate">
                Type an answer on the left or load a sample answer, then click &ldquo;Evaluate answer&rdquo; to see the
                rubric and highlighted citations.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2 text-xs text-slate">
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="size-3.5 text-go" /> 5-point rubric
                </span>
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="size-3.5 text-go" /> Exact quote evidence
                </span>
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="size-3.5 text-go" /> Concrete feedback
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
