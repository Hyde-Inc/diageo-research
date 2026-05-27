import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
      <body className="min-h-full bg-slate-50 text-slate-950">
        <div className="lg:grid lg:min-h-svh lg:grid-cols-[220px_minmax(0,1fr)]">
          <Suspense fallback={<div className="hidden lg:block lg:h-svh lg:w-[220px] lg:border-r lg:border-slate-200 lg:bg-white" />}>
            <GlobalNav />
          </Suspense>
          <div className="min-w-0">
            <Suspense fallback={null}>{children}</Suspense>
          </div>
        </div>
      </body>
    </html>
  );
}
