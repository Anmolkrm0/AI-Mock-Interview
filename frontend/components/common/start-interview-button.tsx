"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Turnstile } from "@/components/common/turnstile";
import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";
import { getSupabaseBrowser } from "@/lib/supabase/client";

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
  const router = useRouter();

  const handleStart = async () => {
    try {
      setLoading(true);
      const supabase = getSupabaseBrowser();
      const session = typeof supabase?.auth?.getSession === "function"
        ? (await supabase.auth.getSession()).data?.session
        : null;
      if (!session && typeof supabase?.auth?.signInAnonymously === "function") {
        const options = captchaToken ? { captchaToken } : undefined;
        const { error } = await supabase.auth.signInAnonymously(options ? { options } : undefined);
        if (error) {
          console.error("Anonymous sign-in error:", error);
        }
      }
      router.push("/interview/setup");
    } catch (err) {
      console.error(err);
      router.push("/interview/setup");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="inline-flex flex-col items-center gap-3">
      {env.turnstileSiteKey && (
        <Turnstile onVerify={setCaptchaToken} onExpire={() => setCaptchaToken(null)} />
      )}
      <Button
        type="button"
        onClick={handleStart}
        loading={loading}
        variant={variant}
        size={size}
        className={className}
      >
        {children}
      </Button>
    </div>
  );
}
