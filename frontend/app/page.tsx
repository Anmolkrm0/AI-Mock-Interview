import { FileText, Mic, ScrollText, Shield } from "lucide-react";
import Link from "next/link";

import { SiteHeader } from "@/components/common/site-header";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const steps = [
  {
    title: "Add your resume and the job",
    body: "Upload a PDF or Word resume and paste the job description. We pull out the skills, projects and requirements, and you can correct anything we got wrong.",
  },
  {
    title: "Pick the role, length and bar",
    body: "Confirm the role, choose 10 to 45 minutes, and decide how hard the interviewer should push.",
  },
  {
    title: "Answer out loud",
    body: "The interviewer asks one question at a time and follows up when an answer is thin. Type instead, skip, or retake an answer whenever you need to.",
  },
  {
    title: "Read what held up",
    body: "Every answer is scored on the same five-point rubric, with the exact lines from your answer that support the score.",
  },
];

const modes = [
  {
    name: "Standard",
    body: "Balanced questions on your experience, core skills and the role. One follow-up at most.",
  },
  {
    name: "Target bar",
    body: "Probes for the specifics expected at the level you're applying for: trade-offs, impact, your own contribution.",
  },
  {
    name: "Stress test",
    body: "Ambiguous scenarios and pointed follow-ups on vague answers. Still calm and professional.",
  },
];

function HeroTranscript() {
  return (
    <figure
      aria-label="Example of an interview transcript with scored evidence"
      className="relative rounded-lg border border-line bg-surface p-6 sm:p-7"
    >
      <div className="space-y-5 text-[15px] leading-relaxed">
        <div>
          <p className="mb-1 text-xs font-medium text-slate">Interviewer</p>
          <p>You mentioned cutting API latency. What did you change, specifically?</p>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-slate">You</p>
          <p>
            We were hitting Postgres on every request, so I{" "}
            <span className="mark-draw">added a read-through Redis cache for the catalogue endpoints</span>. After
            rollout, <span className="mark-draw">p95 dropped from 480 to 190 milliseconds</span>, and I set up alerts on
            cache hit rate.
          </p>
        </div>
      </div>
      <figcaption className="mt-6 flex items-center justify-between gap-4 border-t border-line pt-4">
        <div>
          <p className="font-display text-2xl font-semibold">4 / 5</p>
          <p className="text-sm text-slate">Strong and well-supported</p>
        </div>
        <p className="max-w-[16rem] text-right text-sm text-slate">
          Highlighted lines were found word-for-word in the answer.
        </p>
      </figcaption>
    </figure>
  );
}

export default function LandingPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="mx-auto grid max-w-6xl gap-12 px-5 pb-20 pt-8 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:pt-16">
          <div className="max-w-xl">
            <h1 className="text-[2.6rem] font-semibold sm:text-6xl">
              Rehearse the interview you&apos;re actually walking into.
            </h1>
            <p className="mt-6 text-lg text-slate">
              An AI interviewer reads your resume and the job description, asks role-specific questions out loud, and
              follows up when an answer is thin. Afterwards you see exactly which lines earned each score.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/interview/setup" className={buttonVariants({ size: "lg" })}>
                Start an interview
              </Link>
              <Link href="/login" className={buttonVariants({ variant: "secondary", size: "lg" })}>
                Sign in
              </Link>
            </div>
            <p className="mt-4 text-sm text-slate">
              Needs a microphone and a recent Chrome, Edge or Safari. Camera is optional.
            </p>
          </div>
          <HeroTranscript />
        </section>

        <section aria-labelledby="how" className="border-y border-line bg-surface">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
            <h2 id="how" className="text-3xl font-semibold sm:text-4xl">
              How it works
            </h2>
            <ol className="mt-10 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map((step, i) => (
                <li key={step.title} className="relative">
                  <span className="font-display text-sm font-semibold text-slate">Step {i + 1}</span>
                  <h3 className="mt-2 text-xl font-semibold">{step.title}</h3>
                  <p className="mt-2 text-[15px] text-slate">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="modes" className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
          <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <h2 id="modes" className="text-3xl font-semibold sm:text-4xl">
                Three levels of pressure, one scoring rubric
              </h2>
              <p className="mt-4 text-slate">
                The mode changes how hard the interviewer pushes, not how you&apos;re graded. A 4 in Standard means the
                same thing as a 4 in Stress test.
              </p>
            </div>
            <div className="relative">
              <div
                aria-hidden
                className="absolute bottom-3 left-[7px] top-3 w-0.5 bg-linear-to-b from-line-strong to-ink"
              />
              <ul className="space-y-8">
                {modes.map((mode, i) => (
                  <li key={mode.name} className="relative pl-10">
                    <span
                      aria-hidden
                      className={cn(
                        "absolute left-0 top-1.5 size-4 rounded-full border-2 border-surface",
                        ["bg-line-strong", "bg-slate", "bg-ink"][i],
                      )}
                    />
                    <h3 className="text-xl font-semibold">{mode.name}</h3>
                    <p className="mt-1 text-[15px] text-slate">{mode.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section aria-labelledby="report" className="bg-ink text-white">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
            <h2 id="report" className="max-w-2xl text-3xl font-semibold sm:text-4xl">
              Feedback you can check for yourself
            </h2>
            <dl className="mt-10 grid gap-8 sm:grid-cols-2">
              {[
                {
                  icon: ScrollText,
                  t: "Evidence, not vibes",
                  d: "Each score quotes your own words. If the model cites something you didn't say, the report flags it.",
                },
                {
                  icon: FileText,
                  t: "Skips don't count against you",
                  d: "Skipped questions are listed separately and left out of the score. If there isn't enough to judge, the report says so.",
                },
                {
                  icon: Mic,
                  t: "Content over delivery",
                  d: "Scores look at correctness, reasoning and relevance. Accent, appearance and speaking style are never scored.",
                },
                {
                  icon: Shield,
                  t: "Private by default",
                  d: "Recordings and transcripts are visible only to you. Only your latest recording is kept, and you can delete it anytime.",
                },
              ].map(({ icon: Icon, t, d }) => (
                <div key={t} className="flex gap-4">
                  <Icon aria-hidden className="mt-1 size-5 shrink-0 text-mark" />
                  <div>
                    <dt className="font-display text-lg font-semibold">{t}</dt>
                    <dd className="mt-1 text-[15px] text-white/75">{d}</dd>
                  </div>
                </div>
              ))}
            </dl>
            <div className="mt-12 flex flex-wrap items-center gap-4">
              <Link
                href="/interview/setup"
                className={buttonVariants({ size: "lg", className: "bg-white text-ink hover:bg-paper" })}
              >
                Start an interview
              </Link>
              <p className="text-sm text-white/70">
                Each account can run a few interviews a day, so the shared AI quota lasts for everyone.
              </p>
            </div>
          </div>
        </section>
      </main>
      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm text-slate sm:px-8">
        <p>AI Mock Interview. Practice tool; scores are guidance, not a hiring decision.</p>
        <Link href="/signup" className="underline underline-offset-4">
          Create an account
        </Link>
      </footer>
    </>
  );
}
