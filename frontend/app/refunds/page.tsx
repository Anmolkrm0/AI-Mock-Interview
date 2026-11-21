import { AppHeader } from "@/components/common/app-header";
import { SiteFooter } from "@/components/common/site-footer";

export const metadata = {
  title: "Refund and Cancellation Policy",
  description: "Refund and cancellation terms for Mock Interview credits and sessions.",
};

export default function RefundsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <AppHeader />

      <main id="main" className="flex-1 py-12 sm:py-16">
        <article className="mx-auto max-w-3xl px-5 text-ink sm:px-8">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Refund and Cancellation Policy</h1>
          <p className="mt-2 text-sm text-slate">Last updated: November 2026</p>

          <div className="mt-8 space-y-6 text-sm leading-relaxed text-slate sm:text-base">
            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">1. About the Service</h2>
              <p>
                Mock Interview is an automated AI practice interview platform operated by an individual proprietor based in India (&quot;Mock Interview&quot;, &quot;we&quot;, &quot;us&quot;). We offer pay-as-you-go digital interview credits to practice job interviews.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">2. Automatic Credit Protection (Unstarted / Failed Interviews)</h2>
              <p>
                We believe you should only pay for interviews that actually occur:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <strong>Cancellation before start:</strong> If you cancel an interview before the live session begins, your credits are returned immediately to your account balance.
                </li>
                <li>
                  <strong>Connection or system failures:</strong> If an interview session fails to connect or encounters an unrecoverable system issue prior to starting, your credits are automatically refunded.
                </li>
                <li>
                  <strong>Inactivity expiration:</strong> If an interview is prepared but never started within 30 minutes, our automated housekeeping background worker cancels the session and refunds the credits to your balance.
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">3. Digital Credit Purchases</h2>
              <p>
                Because interview credits grant immediate digital access to on-demand AI compute and evaluation infrastructure, purchased credit packs are strictly <strong>non-refundable</strong> once credited to your account. Credits do not expire and can be used at any future time.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">4. Payment Errors, Duplicate Charges & Uncredited Orders</h2>
              <p>
                In the rare event of:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>A duplicate charge for a single package order, or</li>
                <li>A payment deduction where credits were not applied to your balance and cannot be restored,</li>
              </ul>
              <p>
                We will issue a full refund to your original payment method (via Cashfree Payment Gateway) within <strong>5 to 7 working days</strong> from the date of verification.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-ink">5. Support & Claim Process</h2>
              <p>
                To request assistance with an uncredited order or erroneous transaction, send us a message through our{" "}
                <a href="/contact" className="font-medium text-ink underline underline-offset-4">
                  contact form
                </a>{" "}
                with your Cashfree Order ID and the email address on your account.
              </p>
            </section>
          </div>
        </article>
      </main>

      <SiteFooter />
    </div>
  );
}
