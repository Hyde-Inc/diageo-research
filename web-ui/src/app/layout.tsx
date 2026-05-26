import type { Metadata } from "next";
import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Diageo Research · Hypothesis Workbench",
  description:
    "Multiverse research runs over the same question — Dagster lineage, spec curve, and cap-aware cost.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <nav className="flex items-center gap-5 border-b bg-background/80 px-4 py-2.5 text-sm backdrop-blur sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold tracking-tight"
          >
            <FlaskConical className="h-4 w-4 text-muted-foreground" />
            <span>diageo-research</span>
          </Link>
          <Link
            href="/workbench"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Workbench
          </Link>
        </nav>
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
