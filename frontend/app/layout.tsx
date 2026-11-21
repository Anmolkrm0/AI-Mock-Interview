import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, IBM_Plex_Sans } from "next/font/google";
import Script from "next/script";
import { Toaster } from "sonner";

import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});

const body = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://mockinterview-app.netlify.app"),
  title: {
    default: "AI Mock Interview: practise a real spoken interview for free",
    template: "%s · AI Mock Interview",
  },
  description:
    "Practise a spoken interview for the exact job you're applying to. An AI interviewer asks questions from your resume and the job description, then shows which answers held up and why. First 10-minute interview free, no sign-up needed.",
  applicationName: "Mock Interview",
  keywords: [
    "AI mock interview",
    "mock interview practice",
    "interview preparation",
    "voice interview practice",
    "job interview practice India",
    "interview feedback",
  ],
  openGraph: {
    type: "website",
    siteName: "Mock Interview",
    title: "AI Mock Interview: practise out loud, get scored on evidence",
    description:
      "A free 10-minute AI mock interview built from your resume and the job description. No sign-up needed.",
    url: "/",
    locale: "en_IN",
  },
  twitter: { card: "summary_large_image" },
  ...(process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION
    ? { verification: { google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION } }
    : {}),
};

export const viewport: Viewport = { themeColor: "#16213a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh" suppressHydrationWarning>
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-VT5Z48EW7P"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());

            gtag('config', 'G-VT5Z48EW7P');
          `}
        </Script>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to content
        </a>
        {children}
        <Toaster position="bottom-right" richColors closeButton toastOptions={{ duration: 6000 }} />
      </body>
    </html>
  );
}
