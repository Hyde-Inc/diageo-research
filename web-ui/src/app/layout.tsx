import type { Metadata } from "next";
import Link from "next/link";
import { FlaskConical, Grid2X2 } from "lucide-react";
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
      <body className="flex min-h-full flex-col bg-slate-50 text-slate-950">
        <nav className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 shadow-sm shadow-slate-950/[0.03] backdrop-blur">
          <div className="mx-auto flex h-12 w-full max-w-[1500px] items-center gap-4 px-4 text-sm sm:px-6">
            <Link
              href="/"
              className="flex items-center gap-2 font-semibold tracking-tight text-slate-950"
            >
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-950 text-white shadow-sm">
                <FlaskConical className="h-4 w-4" />
              </span>
              <span>ADC Research</span>
            </Link>
            <div className="h-5 w-px bg-slate-200" />
            <Link
              href="/workbench"
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-white hover:text-slate-950"
            >
              <Grid2X2 className="h-3.5 w-3.5" />
              Workbench
            </Link>
          </div>
        </nav>
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
