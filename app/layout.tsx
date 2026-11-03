import "./dashboard.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "ENCU | Agent Treasury Control",
  description: "Policy control plane for agent-initiated NEAR transfers.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="/developers" style={{ position: "fixed", right: 18, top: 14, zIndex: 100, padding: "9px 12px", border: "1px solid #665333", borderRadius: 8, background: "#241f16", color: "#f3d7a2", fontSize: 11, fontWeight: 700, textDecoration: "none" }}>
          Developer portal
        </a>
        {children}
      </body>
    </html>
  );
}
