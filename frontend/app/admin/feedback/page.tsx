"use client";

import { AppHeader } from "@/components/common/app-header";
import { FeedbackView } from "@/components/admin/feedback-view";

export default function AdminFeedbackPage() {
  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
        <FeedbackView embedded={false} />
      </main>
    </>
  );
}
