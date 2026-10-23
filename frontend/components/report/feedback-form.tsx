"use client";

import { Star } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/field";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { interviewsApi } from "@/services/interviews";

export function FeedbackForm({
  interviewId,
  initial,
}: {
  interviewId: string;
  initial: { rating: number; comments: string | null } | null;
}) {
  const [rating, setRating] = useState(initial?.rating ?? 0);
  const [hover, setHover] = useState(0);
  const [comments, setComments] = useState(initial?.comments ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(Boolean(initial));
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating < 1) {
      setError("Choose a rating from 1 to 5.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await interviewsApi.feedback(interviewId, rating, comments.trim());
      setSaved(true);
      toast.success("Thanks. Your feedback was sent.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const labels = ["", "Not useful", "Slightly useful", "Useful", "Very useful", "Extremely useful"];
  const shown = hover || rating;

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset>
        <legend className="text-sm font-medium">How useful was this interview?</legend>
        <div className="mt-2 flex items-center gap-1" onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <label
              key={n}
              className="cursor-pointer rounded-sm p-1 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ink"
              onMouseEnter={() => setHover(n)}
            >
              <input
                type="radio"
                name="rating"
                value={n}
                checked={rating === n}
                onChange={() => {
                  setRating(n);
                  setSaved(false);
                }}
                className="sr-only"
              />
              <Star className={cn("size-7", n <= shown ? "fill-ink text-ink" : "text-line-strong")} aria-hidden />
              <span className="sr-only">
                {n} out of 5, {labels[n]}
              </span>
            </label>
          ))}
          <span className="ml-3 text-sm text-slate" aria-live="polite">
            {shown ? labels[shown] : ""}
          </span>
        </div>
        {error && (
          <p role="alert" className="mt-1 text-sm text-signal">
            {error}
          </p>
        )}
      </fieldset>
      <div className="space-y-1.5">
        <Label htmlFor="comments">What should we improve? (optional)</Label>
        <Textarea
          id="comments"
          value={comments}
          maxLength={2000}
          onChange={(e) => {
            setComments(e.target.value);
            setSaved(false);
          }}
          placeholder="Questions that felt off, scoring you disagree with, bugs…"
          className="min-h-24"
        />
      </div>
      <Button type="submit" variant="secondary" loading={saving} disabled={saved && !saving}>
        {saved ? "Feedback sent" : "Send feedback"}
      </Button>
    </form>
  );
}
