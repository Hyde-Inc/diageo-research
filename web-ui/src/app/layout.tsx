import type { Metadata } from "next";
import { FlaskConical } from "lucide-react";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import "./globals.css";
import { GlobalNav } from "@/components/global-nav";

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
          <div className="mx-auto flex h-12 w-full max-w-[1500px] items-center gap-3 px-4 text-sm sm:px-6">
            <Link
              href="/"
              className="flex shrink-0 items-center gap-2 font-semibold tracking-tight text-slate-950"
            >
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-950 text-white shadow-sm">
                <FlaskConical className="h-4 w-4" />
              </span>
              <span className="hidden sm:inline">ADC Research</span>
            </Link>
            <span className="hidden h-5 w-px bg-slate-200 sm:block" />
            <Suspense fallback={<div className="h-8 flex-1" />}>
              <GlobalNav />
            </Suspense>
          </div>
        </nav>
        <Suspense fallback={null}>
          <div className="flex-1">{children}</div>
        </Suspense>
      </body>
    </html>
  );
}
