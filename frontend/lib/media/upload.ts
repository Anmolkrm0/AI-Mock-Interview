"use client";

import { env } from "@/lib/env";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import type { UploadUrlOut } from "@/types/api";

/**
 * Upload to a Supabase signed upload URL with progress events.
 * Mirrors supabase-js `uploadToSignedUrl` (PUT, raw body, x-upsert=false) but
 * uses XHR so we can show progress. Falls back to the SDK if XHR is refused.
 */
export function uploadWithProgress(
  slot: UploadUrlOut,
  blob: Blob,
  contentType: string,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${env.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/upload/sign/${slot.bucket}/${slot.path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}?token=${encodeURIComponent(slot.token)}`;

  const viaXhr = new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("apikey", env.supabaseKey);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("content-type", contentType);
    xhr.setRequestHeader("cache-control", "max-age=3600");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and retry."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });

  return viaXhr.catch(async (error: unknown) => {
    if (signal?.aborted) throw error;
    const { error: sdkError } = await getSupabaseBrowser()
      .storage.from(slot.bucket)
      .uploadToSignedUrl(slot.path, slot.token, blob, { contentType, upsert: false });
    if (sdkError) throw error instanceof Error ? error : new Error(String(error));
    onProgress(1);
  });
}
