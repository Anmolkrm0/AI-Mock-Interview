"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/feedback";
import { FieldError, Input, Label } from "@/components/ui/field";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import { missingConfig } from "@/lib/env";
import { safeNextPath, signInSchema, signUpSchema, type SignInValues, type SignUpValues } from "@/lib/validation";

function authErrorMessage(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login")) return "That email and password don't match an account.";
  if (m.includes("email not confirmed")) return "Confirm your email first. Check your inbox for the link.";
  if (m.includes("already registered")) return "An account with this email already exists. Sign in instead.";
  if (m.includes("rate limit") || m.includes("too many")) return "Too many attempts. Wait a minute and try again.";
  if (m.includes("password")) return message;
  return "Couldn't complete that. Check your details and try again.";
}

function ConfigWarning() {
  const missing = missingConfig();
  if (missing.length === 0) return null;
  return (
    <Notice tone="error" title="This app isn't configured yet">
      Set {missing.join(", ")} in frontend/.env.local and restart the dev server.
    </Notice>
  );
}

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({ resolver: zodResolver(signInSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const { error } = await getSupabaseBrowser().auth.signInWithPassword(values);
      if (error) {
        setFormError(authErrorMessage(error.message));
        return;
      }
      router.replace(safeNextPath(params.get("next")));
      router.refresh();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Couldn't sign in.");
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <ConfigWarning />
      {params.get("link") === "invalid" && (
        <Notice tone="error">
          That confirmation link is invalid or has expired. Sign in, or sign up again to get a new link.
        </Notice>
      )}
      {formError && <Notice tone="error">{formError}</Notice>}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          aria-invalid={!!errors.email}
          aria-describedby="email-error"
          {...register("email")}
        />
        <FieldError id="email-error" message={errors.email?.message} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={!!errors.password}
          aria-describedby="password-error"
          {...register("password")}
        />
        <FieldError id="password-error" message={errors.password?.message} />
      </div>
      <Button type="submit" className="w-full" loading={isSubmitting}>
        Sign in
      </Button>
      <p className="text-center text-sm text-slate">
        New here?{" "}
        <Link
          href={`/signup${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`}
          className="font-medium text-ink underline underline-offset-4"
        >
          Create an account
        </Link>
      </p>
    </form>
  );
}

export function SignUpForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpValues>({ resolver: zodResolver(signUpSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const next = safeNextPath(params.get("next"));
      const { data, error } = await getSupabaseBrowser().auth.signUp({
        email: values.email,
        password: values.password,
        options: {
          data: { display_name: values.name },
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) {
        setFormError(authErrorMessage(error.message));
        return;
      }
      if (data.session) {
        router.replace(next);
        router.refresh();
      } else {
        setSentTo(values.email);
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Couldn't create the account.");
    }
  });

  if (sentTo) {
    return (
      <Notice tone="success" title="Check your email">
        We sent a confirmation link to {sentTo}. Open it on this device to finish creating your account.
      </Notice>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <ConfigWarning />
      {formError && <Notice tone="error">{formError}</Notice>}
      <div className="space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          autoComplete="name"
          aria-invalid={!!errors.name}
          aria-describedby="name-error"
          {...register("name")}
        />
        <FieldError id="name-error" message={errors.name?.message} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          aria-invalid={!!errors.email}
          aria-describedby="email-error"
          {...register("email")}
        />
        <FieldError id="email-error" message={errors.email?.message} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.password}
          aria-describedby="password-error"
          {...register("password")}
        />
        <FieldError id="password-error" message={errors.password?.message ?? undefined} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.confirm}
          aria-describedby="confirm-error"
          {...register("confirm")}
        />
        <FieldError id="confirm-error" message={errors.confirm?.message} />
      </div>
      <Button type="submit" className="w-full" loading={isSubmitting}>
        Create account
      </Button>
      <p className="text-center text-sm text-slate">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-ink underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </form>
  );
}
