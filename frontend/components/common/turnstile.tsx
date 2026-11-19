"use client";

import { useEffect, useRef } from "react";
import Script from "next/script";

import { env } from "@/lib/env";

interface TurnstileProps {
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
  className?: string;
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "error-callback"?: () => void;
          "expired-callback"?: () => void;
          theme?: "light" | "dark" | "auto";
        },
      ) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

export function Turnstile({ onVerify, onExpire, onError, className }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const siteKey = env.turnstileSiteKey;

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;

    function renderWidget() {
      if (window.turnstile && containerRef.current && !widgetIdRef.current) {
        try {
          widgetIdRef.current = window.turnstile.render(containerRef.current, {
            sitekey: siteKey,
            callback: onVerify,
            "error-callback": onError,
            "expired-callback": onExpire,
          });
        } catch {
          // ignore render errors if already mounted
        }
      }
    }

    if (typeof window !== "undefined" && window.turnstile) {
      renderWidget();
    } else {
      const interval = setInterval(() => {
        if (typeof window !== "undefined" && window.turnstile) {
          clearInterval(interval);
          renderWidget();
        }
      }, 100);
      return () => clearInterval(interval);
    }

    return () => {
      if (widgetIdRef.current && typeof window !== "undefined" && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {}
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, onVerify, onExpire, onError]);

  if (!siteKey) return null;

  return (
    <div className={className}>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="lazyOnload"
      />
      <div ref={containerRef} />
    </div>
  );
}
