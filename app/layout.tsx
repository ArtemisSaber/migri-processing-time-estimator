import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Migri Wait Estimate",
  description: "A rough processing-time estimate built from Migri public statistics.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
