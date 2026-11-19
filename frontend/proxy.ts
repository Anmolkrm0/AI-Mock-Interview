import { NextResponse, type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

export function getLegacyRedirectUrl(target: string | undefined, request: NextRequest): URL | null {
  if (!target) return null;
  const trimmed = target.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || !parsed.hostname) return null;
    const destination = new URL(parsed.origin);
    destination.pathname = request.nextUrl.pathname;
    destination.search = request.nextUrl.search;
    return destination;
  } catch {
    return null;
  }
}

// Next.js 16 uses proxy.ts (formerly middleware.ts).
export async function proxy(request: NextRequest) {
  const redirectUrl = getLegacyRedirectUrl(process.env.LEGACY_REDIRECT_TO, request);
  if (redirectUrl) {
    return NextResponse.redirect(redirectUrl, 308);
  }
  return await updateSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|worklets/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|js)$).*)"],
};
