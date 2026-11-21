import { AppHeader } from "@/components/common/app-header";
import { SiteFooter } from "@/components/common/site-footer";

export const metadata = {
  title: "Privacy Policy",
  description: "Privacy policy for Mock Interview candidates and visitors.",
};

export default function PrivacyPage() {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <AppHeader />

      <main id="main" className="flex-1 py-12 sm:py-16">
        <article className="mx-auto max-w-3xl px-5 text-ink sm:px-8">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Privacy Policy</h1>
          <p className="mt-2 text-sm text-slate">Last updated: November 2026</p>

          <div className="mt-8 space-y-6 text-sm leading-relaxed text-slate sm:text-base">
            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">1. Overview</h2>
              <p>
                Mock Interview is committed to respecting and protecting your privacy. This Privacy Policy explains how your personal data, resumes, voice recordings, and interview transcripts are handled when you use our website and application.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">2. Information We Collect</h2>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <strong>Account information:</strong> Email address and profile details when you sign up or log in.
                </li>
                <li>
                  <strong>Uploaded documents:</strong> Resumes and job descriptions submitted to generate interview questions. We extract skills, experience, and requirements; we do not sell or share your resume with third-party advertisers.
                </li>
                <li>
                  <strong>Audio and transcripts:</strong> Audio answers are streamed to Google Gemini Live API in real time for conversational interaction and scoring. Transcripts are stored in your private database account.
                </li>
                <li>
                  <strong>Guest security data:</strong> Salted, one-way hashes of IP addresses are temporarily used to enforce fair usage limits for guest sessions; raw IP addresses are never permanently logged or stored.
                </li>
                <li>
                  <strong>Payment data:</strong> Payments are processed directly by Cashfree Payment Gateway. We store only transactional metadata (order ID, amount, credit count, status); we never store your credit/debit card numbers or UPI PINs.
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">3. Recording & Data Retention</h2>
              <p>
                To safeguard your privacy and minimize storage footprint:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Only your most recent audio recording is preserved. When a new recording is made, older recordings are scheduled for immediate background deletion.</li>
                <li>Guests do not have recordings retained.</li>
                <li>If you try a free interview without signing up, your account, resume and report are deleted after 48 hours. We keep only an anonymous summary (role, status and score) to count how the free interview is used.</li>
                <li>Our team may review interview reports to answer support requests and improve question and scoring quality.</li>
                <li>You can delete your documents and recordings at any time from your settings.</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">4. Third-Party Service Providers</h2>
              <p>
                We use the following infrastructure partners to operate the platform:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li><strong>Supabase:</strong> Authentication, relational PostgreSQL database, and private object storage.</li>
                <li><strong>Google Cloud (Gemini API):</strong> Live conversational speech, question formulation, and rubric scoring.</li>
                <li><strong>Cashfree Payments:</strong> Secure RBI-licensed payment gateway in India.</li>
                <li><strong>Cloudflare:</strong> DDoS mitigation and Turnstile bot verification.</li>
                <li><strong>Google Analytics:</strong> Anonymous usage statistics, such as which pages are visited, interviews started and credit packs bought. We do not send your name, email, resume or interview content to it.</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">5. Contact & Deletion Requests</h2>
              <p>
                To request full deletion of your profile, interviews, and associated data, please send us a message through our{" "}
                <a href="/contact" className="font-medium text-ink underline underline-offset-4">
                  contact form
                </a>.
              </p>
            </section>
          </div>
        </article>
      </main>

      <SiteFooter />
    </div>
  );
}
