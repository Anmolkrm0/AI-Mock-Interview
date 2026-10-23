/**
 * Public configuration. Missing values are reported clearly instead of being
 * replaced with placeholders.
 */
export const env = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, ""),
  recordingMaxBytes: Number(process.env.NEXT_PUBLIC_RECORDING_MAX_BYTES ?? 52428800),
};

export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!env.supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!env.supabaseKey) missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (!env.apiUrl) missing.push("NEXT_PUBLIC_API_URL");
  return missing;
}
