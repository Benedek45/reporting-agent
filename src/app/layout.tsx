import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reporting Agent",
  description: "Draft CSRD & ESG reports with an AI assistant.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
