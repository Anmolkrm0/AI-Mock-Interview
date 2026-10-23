import type { Metadata } from "next";
import { Suspense } from "react";

import { SignInForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <AuthShell
      title="Sign in"
      subtitle="Pick up where you left off: your interviews and reports are saved to your account."
    >
      <Suspense>
        <SignInForm />
      </Suspense>
    </AuthShell>
  );
}
