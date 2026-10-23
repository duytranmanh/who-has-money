import type { Metadata } from "next";
import "xp.css/dist/XP.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Who Has Money?",
  description: "Browse recently funded companies, funding amounts, and announcement dates.",
};

// Apply the shared XP theme to the company browser.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
