import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing: interview credit packs from ₹149",
  description:
    "One-time interview credit packs, no subscription. 1 credit = a 10-minute AI mock interview. Credits never expire, and failed interviews are refunded automatically.",
};

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
