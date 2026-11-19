"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
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
  const router = useRouter();

  const handleStart = async () => {
    try {
      setLoading(true);
      const supabase = getSupabaseBrowser();
      const session = typeof supabase?.auth?.getSession === "function"
        ? (await supabase.auth.getSession()).data?.session
        : null;
      if (!session && typeof supabase?.auth?.signInAnonymously === "function") {
        const { error } = await supabase.auth.signInAnonymously();
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
  );
}
