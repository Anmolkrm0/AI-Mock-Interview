import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

// Next.js 16 uses proxy.ts (formerly middleware.ts).
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|worklets/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|js)$).*)"],
};
