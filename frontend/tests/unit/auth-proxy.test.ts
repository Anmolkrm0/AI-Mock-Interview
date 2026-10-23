import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

let claims: { sub?: string } | null = null;

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
    claims = { sub: "user-1" };
    const res = await updateSession(req("/login"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
    expect((await updateSession(req("/dashboard"))).headers.get("location")).toBeNull();
  });
});
