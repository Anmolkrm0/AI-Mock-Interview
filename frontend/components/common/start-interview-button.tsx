"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Turnstile, type TurnstileRef } from "@/components/common/turnstile";
import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

interface StartInterviewButtonProps {
  className?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg" | "icon";
  children?: React.ReactNode;
}

export function StartInterviewButton({
  className,
  variant,
  size = "lg",
  children = "Start an interview",
}: StartInterviewButtonProps) {
  const [loading, setLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileRef>(null);
  const router = useRouter();

  const handleStart = async () => {
    try {
      setLoading(true);
      setErrorMessage(null);
      const supabase = getSupabaseBrowser();
      const session =
        typeof supabase?.auth?.getSession === "function"
          ? (await supabase.auth.getSession()).data?.session
          : null;
      if (!session && typeof supabase?.auth?.signInAnonymously === "function") {
        const options = captchaToken ? { captchaToken } : undefined;
        const { error } = await supabase.auth.signInAnonymously(options ? { options } : undefined);
        if (error) {
          console.error("Anonymous sign-in error:", error);
          setErrorMessage("We couldn't start your free interview. Please tick the check again or refresh.");
          setCaptchaToken(null);
          turnstileRef.current?.reset();
          return;
        }
      }
      router.push("/interview/setup");
    } catch (err) {
      console.error(err);
      setErrorMessage("We couldn't start your free interview. Please tick the check again or refresh.");
      setCaptchaToken(null);
      turnstileRef.current?.reset();
    } finally {
      setLoading(false);
    }
  };

  const hasSiteKey = Boolean(env.turnstileSiteKey);
  const isStartDisabled = loading || (hasSiteKey && !captchaToken);

  return (
    <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-start">
      {hasSiteKey && (
        <div className="flex w-full flex-col items-start gap-1.5">
          <Turnstile
            ref={turnstileRef}
            onVerify={(token) => {
              setCaptchaToken(token);
              setErrorMessage(null);
            }}
            onExpire={() => setCaptchaToken(null)}
          />
          {!captchaToken && (
            <p className="text-xs text-slate">Tick the box above to start</p>
          )}
        </div>
      )}
      <Button
        type="button"
        onClick={handleStart}
        loading={loading}
        disabled={isStartDisabled}
        variant={variant}
        size={size}
        className={cn("w-full sm:w-auto", className)}
      >
        {children}
      </Button>
      {errorMessage && (
        <p className="max-w-sm text-left text-xs text-signal" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
