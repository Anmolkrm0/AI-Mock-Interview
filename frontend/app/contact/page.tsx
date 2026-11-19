"use client";

import { Mail, Send } from "lucide-react";
import { useRef, useState } from "react";

import { AppHeader } from "@/components/common/app-header";
import { SiteFooter } from "@/components/common/site-footer";
import { Turnstile, type TurnstileRef } from "@/components/common/turnstile";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/field";
import { env } from "@/lib/env";
import { contactApi } from "@/services/contact";

export default function ContactPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const turnstileRef = useRef<TurnstileRef>(null);
  const hasSiteKey = Boolean(env.turnstileSiteKey);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) return;

    try {
      setSubmitting(true);
      setError(null);
      await contactApi.submit({
        name: name.trim(),
        email: email.trim(),
        message: message.trim(),
        captcha_token: captchaToken,
      });
      setSubmitted(true);
      setName("");
      setEmail("");
      setMessage("");
      setCaptchaToken(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send message. Please try again.");
      turnstileRef.current?.reset();
      setCaptchaToken(null);
    } finally {
      setSubmitting(false);
    }
  };

  const isSubmitDisabled = submitting || (hasSiteKey && !captchaToken);

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <AppHeader />

      <main id="main" className="flex-1 py-12 sm:py-16">
        <div className="mx-auto max-w-2xl px-5 sm:px-8">
          <div className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              Contact & Support
            </h1>
            <p className="mt-3 text-slate">
              Have questions, issues with interview credits, or payment feedback? We&apos;re here to help.
            </p>
          </div>

          <div className="mt-8 rounded-xl border border-line bg-surface p-6 sm:p-8">
            <div className="mb-6 flex items-center gap-3 border-b border-line pb-6 text-sm text-slate">
              <Mail className="size-5 shrink-0 text-ink" />
              <span>
                Direct email:{" "}
                <a
                  href={`mailto:${env.supportEmail}`}
                  className="font-medium text-ink underline underline-offset-4 hover:text-ink"
                >
                  {env.supportEmail}
                </a>
              </span>
            </div>

            {submitted ? (
              <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-6 text-center">
                <h2 className="text-lg font-semibold text-emerald-800 dark:text-emerald-300">
                  Message Sent!
                </h2>
                <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">
                  Thank you for reaching out. We will review your message and respond to your email as soon as possible.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-5"
                  onClick={() => setSubmitted(false)}
                >
                  Send another message
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                {error && (
                  <div className="rounded-md border border-signal/20 bg-signal/10 p-3 text-sm text-signal" role="alert">
                    {error}
                  </div>
                )}

                <div>
                  <Label htmlFor="contact-name">Your Name</Label>
                  <Input
                    id="contact-name"
                    type="text"
                    required
                    maxLength={128}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Full Name"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="contact-email">Email Address</Label>
                  <Input
                    id="contact-email"
                    type="email"
                    required
                    maxLength={255}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label htmlFor="contact-message">Message</Label>
                  <Textarea
                    id="contact-message"
                    required
                    rows={5}
                    maxLength={5000}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Describe your inquiry, order issue, or feedback in detail…"
                    className="mt-1"
                  />
                </div>

                {hasSiteKey && (
                  <div className="space-y-1.5 pt-1">
                    <Turnstile
                      ref={turnstileRef}
                      onVerify={(token) => {
                        setCaptchaToken(token);
                        setError(null);
                      }}
                      onExpire={() => setCaptchaToken(null)}
                    />
                    {!captchaToken && (
                      <p className="text-xs text-slate">Tick the box above to submit</p>
                    )}
                  </div>
                )}

                <Button
                  type="submit"
                  loading={submitting}
                  disabled={isSubmitDisabled}
                  className="w-full sm:w-auto"
                >
                  <Send className="mr-2 size-4" /> Send message
                </Button>
              </form>
            )}
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
