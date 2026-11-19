import { AppHeader } from "@/components/common/app-header";
import { SiteFooter } from "@/components/common/site-footer";
import { env } from "@/lib/env";

export const metadata = {
  title: "Terms of Service | Mock Interview",
  description: "Terms and conditions for using Mock Interview.",
};

export default function TermsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <AppHeader />

      <main id="main" className="flex-1 py-12 sm:py-16">
        <article className="mx-auto max-w-3xl px-5 text-ink sm:px-8">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Terms of Service</h1>
          <p className="mt-2 text-sm text-slate">Last updated: November 2026</p>

          <div className="mt-8 space-y-6 text-sm leading-relaxed text-slate sm:text-base">
            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">1. Acceptance of Terms</h2>
              <p>
                By accessing or using Mock Interview (&quot;the Service&quot;), operated by an individual proprietor based in India, you agree to be bound by these Terms of Service. If you do not agree to these terms, do not access or use the Service.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">2. Nature of the Service</h2>
              <p>
                Mock Interview provides an automated AI rehearsal environment designed to help individuals practice interview scenarios. You acknowledge and agree that:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Mock Interview is an educational practice tool only.</li>
                <li>Scores, ratings, and evaluation reports are algorithmic feedback and do not constitute hiring guarantees, job offers, or professional career endorsements.</li>
                <li>AI models may occasionally generate unintended or inaccurate observations.</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">3. Accounts & Guest Sessions</h2>
              <p>
                Visitors may start a single guest interview without signing up. Registered accounts may purchase interview credit packs. You are responsible for maintaining the confidentiality of your login credentials and for all activities that occur under your account.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">4. Acceptable Use</h2>
              <p>
                You agree not to misuse the service, including:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Attempting to bypass security barriers, rate limits, or quota controls.</li>
                <li>Uploading malicious files, illegal materials, or harmful content.</li>
                <li>Interfering with or disrupting the integrity or performance of the API servers.</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">5. Pricing & Payments</h2>
              <p>
                Credit packages are priced in Indian Rupees (INR) and processed via Cashfree Payment Gateway. All fees are displayed clearly before purchase. Refunds and cancellations are governed by our{" "}
                <a href="/refunds" className="font-medium text-ink underline underline-offset-4">
                  Refund Policy
                </a>.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">6. Contact Information</h2>
              <p>
                For questions regarding these terms, contact us at{" "}
                <a href={`mailto:${env.supportEmail}`} className="font-medium text-ink underline underline-offset-4">
                  {env.supportEmail}
                </a>{" "}
                or via our{" "}
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
