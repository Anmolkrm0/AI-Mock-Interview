"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/feedback";

export function PhoneNotice({ className }: { className?: string }) {
  const [isPhone, setIsPhone] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    function check() {
      if (typeof window === "undefined") return;
      const coarse =
        typeof window.matchMedia === "function" ? window.matchMedia("(pointer: coarse)").matches : false;
      const small = window.innerWidth < 768;
      setIsPhone(coarse && small);
    }
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  if (!isPhone || dismissed) return null;

  return (
    <Notice
      tone="info"
      className={className}
      action={
        <Button size="sm" variant="secondary" onClick={() => setDismissed(true)}>
          Continue anyway
        </Button>
      }
    >
      Interviews work best on a laptop with Chrome and headphones.
    </Notice>
  );
}
