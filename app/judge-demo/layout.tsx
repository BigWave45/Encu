import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "ENCU | Autonomous Agent Payment Controls",
  description: "Explore ENCU's policy controls, shared treasury reservations and NEAR finality verification for autonomous agent payments.",
};

export default function JudgeDemoLayout({ children }: { children: ReactNode }) {
  return children;
}
