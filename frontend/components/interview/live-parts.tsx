"use client";

import { Keyboard, Mic, MicOff, RotateCcw, SkipForward, Wifi, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/feedback";
import { Textarea } from "@/components/ui/field";
import type { Phase } from "@/lib/live/interview-conductor";
import { cn, formatDuration } from "@/lib/utils";
import type { QuestionOut, TranscriptLine } from "@/types/api";

export function Countdown({ getRemaining }: { getRemaining: () => number | null }) {
  const [remaining, setRemaining] = useState<number | null>(getRemaining());
  useEffect(() => {
    const t = setInterval(() => setRemaining(getRemaining()), 500);
    return () => clearInterval(t);
  }, [getRemaining]);
  if (remaining === null) return <span className="font-display text-2xl tabular-nums text-slate">--:--</span>;
  const low = remaining <= 120;
  return (
    <span
      role="timer"
      aria-label={`${Math.floor(remaining / 60)} minutes ${remaining % 60} seconds remaining`}
      className={cn("font-display text-2xl font-semibold tabular-nums", low && "text-signal")}
    >
      {formatDuration(remaining)}
    </span>
  );
}

export function ConnectionStatus({ phase, ready = true }: { phase: Phase; ready?: boolean }) {
  const map: Record<Phase, { label: string; tone: string; icon: typeof Wifi }> = {
    idle: { label: "Not connected", tone: "text-slate", icon: WifiOff },
    connecting: { label: "Connecting to your interviewer…", tone: "text-wait", icon: Wifi },
    live: {
      label: ready ? "Connected" : "Connecting to your interviewer…",
      tone: ready ? "text-go" : "text-wait",
      icon: Wifi,
    },
    reconnecting: { label: "Reconnecting", tone: "text-wait", icon: WifiOff },
    ending: { label: "Saving", tone: "text-slate", icon: Wifi },
    ended: { label: "Ended", tone: "text-slate", icon: WifiOff },
    error: { label: "Disconnected", tone: "text-signal", icon: WifiOff },
  };
  const s = map[phase];
  const Icon = s.icon;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-sm font-medium", s.tone)}
      role="status"
      aria-live="polite"
    >
      <Icon className="size-4" aria-hidden /> {s.label}
    </span>
  );
}

/** Interviewer presence: a quiet set of bars that move only while it speaks. */
export function InterviewerPresence({
  speaking,
  listening,
  connecting,
}: {
  speaking: boolean;
  listening: boolean;
  connecting?: boolean;
}) {
  return (
    <div className="flex items-center gap-4">
      <div aria-hidden className="flex h-10 items-end gap-1">
        {[0.5, 0.9, 0.65, 1, 0.7, 0.45].map((h, i) => (
          <span
            key={i}
            className={cn(
              "w-1.5 rounded-full bg-ink transition-all duration-300",
              speaking ? "animate-pulse" : "opacity-25",
            )}
            style={{ height: `${(speaking ? h : 0.2) * 100}%`, animationDelay: `${i * 90}ms` }}
          />
        ))}
      </div>
      <p className="text-sm font-medium" aria-live="polite">
        {speaking
          ? "Interviewer is speaking"
          : connecting
            ? "Connecting…"
            : listening
              ? "Start speaking"
              : "Waiting"}
      </p>
    </div>
  );
}

export function MicMeter({ level, muted }: { level: number; muted: boolean }) {
  const pct = Math.min(100, Math.round(level * 400));
  return (
    <div className="flex items-center gap-2 text-sm text-slate">
      {muted ? <MicOff className="size-4" aria-hidden /> : <Mic className="size-4 text-ink" aria-hidden />}
      <span className="sr-only">{muted ? "Microphone paused" : "Microphone on"}</span>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-line" aria-hidden>
        <div className="h-full bg-go transition-[width] duration-100" style={{ width: `${muted ? 0 : pct}%` }} />
      </div>
    </div>
  );
}

export function QuestionPanel({
  questions,
  currentIndex,
  isConnecting = false,
}: {
  questions: QuestionOut[];
  currentIndex: number | null;
  isConnecting?: boolean;
}) {
  const done = questions.filter((q) => q.status === "answered" || q.status === "skipped").length;
  const core = questions.filter((q) => q.priority === "core").length || questions.length;
  const current = currentIndex !== null ? questions[currentIndex] : undefined;
  const connecting = isConnecting || (!current && done === 0);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 text-sm text-slate">
        <span>
          {current
            ? current.priority === "optional"
              ? "Bonus question"
              : `Question ${current.sequence_number} of ${core}`
            : connecting
              ? "Connecting…"
              : "Between questions"}
        </span>
        <span>{done} done</span>
      </div>
      <ProgressBar value={(Math.min(done, core) / core) * 100} label="Interview progress" />
      <p className="font-display text-2xl font-semibold leading-snug sm:text-[1.75rem]" aria-live="polite">
        {current
          ? current.question_text
          : connecting
            ? "Connecting to your interviewer… Please wait."
            : "The interviewer will continue shortly."}
      </p>
      {current && (
        <p className="text-sm text-slate">
          {current.competency}
          {current.status === "retaking" && ", retaking your answer"}
        </p>
      )}
    </div>
  );
}

export function Transcript({
  lines,
  partial,
}: {
  lines: TranscriptLine[];
  partial: { speaker: string; text: string } | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 120;
    if (nearBottom) endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length, partial?.text]);

  const lastLine = lines[lines.length - 1];
  const isDuplicatePartial = Boolean(
    partial &&
      lastLine &&
      lastLine.speaker === partial.speaker &&
      lastLine.text.trim().toLowerCase() === partial.text.trim().toLowerCase(),
  );
  const showPartial = partial && !isDuplicatePartial;

  return (
    <div ref={containerRef} className="h-full overflow-y-auto pr-1" aria-label="Live transcript" tabIndex={0}>
      {lines.length === 0 && !showPartial && <p className="text-sm text-slate">The transcript appears here as you talk.</p>}
      <ol className="space-y-4">
        {lines.map((l, i) => (
          <li key={i} className={cn(l.speaker === "candidate" && "pl-4 border-l-2 border-line-strong")}>
            <p className="text-xs font-medium text-slate">{l.speaker === "candidate" ? "You" : "Interviewer"}</p>
            <p className="text-[15px] leading-relaxed">{l.text}</p>
          </li>
        ))}
        {showPartial && (
          <li className={cn("opacity-70", partial.speaker === "candidate" && "pl-4 border-l-2 border-line-strong")}>
            <p className="text-xs font-medium text-slate">{partial.speaker === "candidate" ? "You" : "Interviewer"}</p>
            <p className="text-[15px] leading-relaxed">{partial.text}</p>
          </li>
        )}
      </ol>
      <div ref={endRef} />
    </div>
  );
}

export function Controls({
  disabled,
  inputMode,
  canSkip,
  canRetake,
  onToggleText,
  onSkip,
  onRetake,
}: {
  disabled: boolean;
  inputMode: "voice" | "text";
  canSkip: boolean;
  canRetake: boolean;
  onToggleText: () => void;
  onSkip: () => void;
  onRetake: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={onToggleText} disabled={disabled} aria-pressed={inputMode === "text"}>
        {inputMode === "text" ? <Mic /> : <Keyboard />}
        {inputMode === "text" ? "Answer by voice" : "Type an answer"}
      </Button>
      <Button variant="secondary" onClick={onRetake} disabled={disabled || !canRetake}>
        <RotateCcw /> Retake answer
      </Button>
      <Button variant="secondary" onClick={onSkip} disabled={disabled || !canSkip}>
        <SkipForward /> Skip question
      </Button>
    </div>
  );
}

export function TypedAnswer({ disabled, onSubmit }: { disabled: boolean; onSubmit: (text: string) => boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  function send() {
    if (text.trim() && onSubmit(text)) setText("");
  }
  return (
    <div className="space-y-2">
      <label htmlFor="typed" className="text-sm font-medium">
        Your answer
      </label>
      <Textarea
        id="typed"
        ref={ref}
        value={text}
        disabled={disabled}
        maxLength={8000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        placeholder="Type your answer. Enter sends it, Shift+Enter adds a new line."
        className="min-h-28"
      />
      <div className="flex justify-end">
        <Button onClick={send} disabled={disabled || !text.trim()}>
          Send answer
        </Button>
      </div>
    </div>
  );
}
