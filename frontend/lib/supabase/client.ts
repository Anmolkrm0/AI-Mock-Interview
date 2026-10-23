"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";

let client: SupabaseClient | null = null;

/** Browser Supabase client (publishable key only). Singleton per tab. */
export function getSupabaseBrowser(): SupabaseClient {
  if (!client) {
    if (!env.supabaseUrl || !env.supabaseKey) {
      throw new Error(
        "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
      );
    }
    client = createBrowserClient(env.supabaseUrl, env.supabaseKey);
  }
  return client;
}
