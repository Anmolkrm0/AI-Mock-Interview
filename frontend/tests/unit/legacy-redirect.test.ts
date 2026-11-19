import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims: async () => ({ data: null }) } }),
}));

import { getLegacyRedirectUrl, proxy } from "@/proxy";

function req(path: string) {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

describe("legacy redirect in proxy.ts", () => {
  const originalEnv = process.env.LEGACY_REDIRECT_TO;

  beforeEach(() => {
    delete process.env.LEGACY_REDIRECT_TO;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.LEGACY_REDIRECT_TO = originalEnv;
    } else {
      delete process.env.LEGACY_REDIRECT_TO;
    }
  });

  it("unset: no redirect, behaves exactly as today", async () => {
    delete process.env.LEGACY_REDIRECT_TO;
    const request = req("/");
    expect(getLegacyRedirectUrl(undefined, request)).toBeNull();
    const res = await proxy(request);
    // When signed out on public page "/", updateSession returns NextResponse.next()
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("set: returns 308 redirect with path and query kept", async () => {
    process.env.LEGACY_REDIRECT_TO = "https://mockinterview.netlify.app";
    const request = req("/interview/abc-123/live?camera=on&step=2");

    // Check helper
    const url = getLegacyRedirectUrl(process.env.LEGACY_REDIRECT_TO, request);
    expect(url).not.toBeNull();
    expect(url?.toString()).toBe("https://mockinterview.netlify.app/interview/abc-123/live?camera=on&step=2");

    // Check proxy execution
    const res = await proxy(request);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://mockinterview.netlify.app/interview/abc-123/live?camera=on&step=2");
  });

  it("set with trailing slash: redirects to origin with path and query kept", async () => {
    process.env.LEGACY_REDIRECT_TO = "https://mockinterview.netlify.app/";
    const request = req("/dashboard?tab=history");
    const res = await proxy(request);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://mockinterview.netlify.app/dashboard?tab=history");
  });

  it("invalid value: ignored when not https or malformed", async () => {
    const invalidValues = [
      "http://mockinterview.netlify.app",
      "ftp://mockinterview.netlify.app",
      "not-a-valid-url",
      "javascript:alert(1)",
      "",
      "   ",
      "https://",
      "//example.com",
    ];

    for (const invalid of invalidValues) {
      process.env.LEGACY_REDIRECT_TO = invalid;
      const request = req("/dashboard");
      expect(getLegacyRedirectUrl(invalid, request)).toBeNull();

      const res = await proxy(request);
      // For invalid LEGACY_REDIRECT_TO, proxy falls through to updateSession.
      // For signed-out user on protected "/dashboard", updateSession redirects to /login (307),
      // never 308 to the invalid target!
      expect(res.status).not.toBe(308);
      const loc = res.headers.get("location");
      if (loc) {
        expect(new URL(loc).pathname).toBe("/login");
        expect(new URL(loc).origin).toBe("http://localhost:3000");
      }
    }
  });
});
