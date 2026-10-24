"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { LoadError, WakingNotice } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/feedback";
import { ApiError, errorMessage } from "@/lib/api";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { formatBytes, formatDate, formatDuration } from "@/lib/utils";
import { interviewsApi, recordingsApi, usersApi } from "@/services/interviews";
import type { RecordingOut } from "@/types/api";

export default function SettingsPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [recording, setRecording] = useState<RecordingOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const slowTimer = setTimeout(() => setSlow(true), 4000);
    getSupabaseBrowser()
      .auth.getUser()
      .then(({ data }) => setEmail(data.user?.email ?? null))
      .catch(() => setEmail(null));
    recordingsApi
      .latest()
      .then(setRecording)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setRecording(null);
        else setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        clearTimeout(slowTimer);
        setLoading(false);
        setSlow(false);
      });
    return () => clearTimeout(slowTimer);
  }, []);

  async function play() {
    if (!recording) return;
    try {
      const { url } = await interviewsApi.recordingUrl(recording.interview_id);
      setPlayUrl(url);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await recordingsApi.deleteLatest();
      setRecording(null);
      setPlayUrl(null);
      setConfirmOpen(false);
      toast.success("Recording deleted. Your reports and transcripts are unchanged.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  }

  async function removeAccount() {
    setDeletingAccount(true);
    try {
      await usersApi.deleteAccount();
      await getSupabaseBrowser().auth.signOut();
      toast.success("Your account and all associated data have been permanently deleted.");
      router.push("/");
    } catch (e) {
      toast.error(errorMessage(e));
      setDeletingAccount(false);
    }
  }

  return (
    <main id="main" className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
      <h1 className="text-4xl font-semibold">Settings</h1>

      <section aria-labelledby="account" className="mt-10 border-t border-line pt-8">
        <h2 id="account" className="text-xl font-semibold">
          Account
        </h2>
        <p className="mt-2 text-slate">Signed in as {email ?? "…"}</p>
        <div className="mt-4">
          <Button variant="danger" size="sm" onClick={() => setConfirmDeleteAccount(true)}>
            <Trash2 /> Delete account
          </Button>
        </div>
      </section>

      <section aria-labelledby="rec" className="mt-10 border-t border-line pt-8">
        <h2 id="rec" className="text-xl font-semibold">
          Interview recording
        </h2>
        <p className="mt-2 text-slate">
          We keep only your most recent recording. When you record a new interview, the previous recording is replaced.
          Reports and transcripts are kept until you delete them.
        </p>
        <div className="mt-5">
          {slow && loading && (
            <div className="mb-4">
              <WakingNotice />
            </div>
          )}
          {loading && <Skeleton className="h-20 w-full" />}
          {error && <LoadError error={error} />}
          {!loading && !error && !recording && (
            <p className="rounded-md border border-dashed border-line-strong bg-surface px-4 py-5 text-slate">
              You don&apos;t have a stored recording.
            </p>
          )}
          {recording && (
            <div className="space-y-4 rounded-md border border-line bg-surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {recording.mime_type.startsWith("video") ? "Video" : "Audio"} recording,{" "}
                    {recording.duration_seconds ? formatDuration(recording.duration_seconds) : "unknown length"}
                  </p>
                  <p className="text-sm text-slate">
                    {formatBytes(recording.file_size_bytes)}, saved {formatDate(recording.created_at)}.{" "}
                    <Link href={`/interview/${recording.interview_id}/report`} className="underline underline-offset-4">
                      Open its report
                    </Link>
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={play}>
                    Play
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)}>
                    <Trash2 /> Delete
                  </Button>
                </div>
              </div>
              {playUrl &&
                (recording.mime_type.startsWith("video") ? (
                  <video src={playUrl} controls className="w-full rounded-md bg-ink" />
                ) : (
                  <audio src={playUrl} controls className="w-full" />
                ))}
            </div>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={remove}
        loading={deleting}
        title="Delete your recording?"
        description="The recording file is permanently deleted. Your interview report and transcript stay available until deleted."
        confirmLabel="Delete recording"
      />

      <ConfirmDialog
        open={confirmDeleteAccount}
        onClose={() => setConfirmDeleteAccount(false)}
        onConfirm={removeAccount}
        loading={deletingAccount}
        title="Delete your account?"
        description="This permanently deletes your account, all interviews, transcripts, reports, documents, and recordings. This cannot be undone."
        confirmLabel="Delete account"
      />
    </main>
  );
}
