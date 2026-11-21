import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact",
  description: "Questions about interviews, credits or a payment? Send the Mock Interview team a message.",
};

export default function ContactLayout({ children }: { children: React.ReactNode }) {
  return children;
}
