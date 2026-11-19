import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

let claims: { sub?: string; is_anonymous?: boolean } | null = null;

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims: async () => ({ data: claims ? { claims } : null }) } }),
}));

import { updateSession } from "@/lib/supabase/proxy";

function req(path: string) {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

describe("route protection", () => {
  it("redirects signed-out users from protected pages to login with a return path", async () => {
    claims = null;
    for (const path of ["/dashboard", "/interview/setup", "/interview/abc/live", "/settings", "/admin", "/admin/feedback"]) {
      const res = await updateSession(req(path));
      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("next")).toBe(path);
    }
  });

  it("lets signed-out users see public pages", async () => {
    claims = null;
    for (const path of ["/", "/login", "/signup"]) {
      expect((await updateSession(req(path))).headers.get("location")).toBeNull();
    }
  });

  it("sends signed-in users away from auth pages", async () => {
    claims = { sub: "user-1", is_anonymous: false };
    const res = await updateSession(req("/login"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
    expect((await updateSession(req("/dashboard"))).headers.get("location")).toBeNull();
  });

  it("allows anonymous sessions to open /interview/* but redirects /dashboard, /settings, /admin to /signup", async () => {
    claims = { sub: "guest-1", is_anonymous: true };

    // Allowed interview paths
    for (const path of ["/interview/setup", "/interview/abc/live", "/interview/abc/report"]) {
      const res = await updateSession(req(path));
      expect(res.headers.get("location")).toBeNull();
    }

    // Public pages and auth pages are accessible for anonymous sessions
    for (const path of ["/", "/login", "/signup"]) {
      const res = await updateSession(req(path));
      expect(res.headers.get("location")).toBeNull();
    }

    // Protected pages require registered account -> redirect to /signup?next=...
    for (const path of ["/dashboard", "/settings", "/admin", "/admin/feedback"]) {
      const res = await updateSession(req(path));
      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname).toBe("/signup");
      expect(location.searchParams.get("next")).toBe(path);
    }
  });
});
