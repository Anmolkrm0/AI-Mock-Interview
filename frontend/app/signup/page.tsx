import type { Metadata } from "next";
import { Suspense } from "react";

import { SignUpForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <AuthShell title="Create your account" subtitle="Your interviews, transcripts and reports are private to you.">
      <Suspense>
        <SignUpForm />
      </Suspense>
    </AuthShell>
  );
}
