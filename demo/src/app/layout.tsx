import type { Metadata } from "next";
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
  title: "ossgard — AI-Powered Duplicate PR Detection for Open Source",
  description:
    "ossgard scans open-source repositories and detects duplicate pull requests using AI-powered code and intent analysis. Save maintainer time by identifying redundant PRs automatically.",
  keywords: [
    "duplicate pull requests",
    "open source",
    "PR deduplication",
    "AI code analysis",
    "ossgard",
    "GitHub",
    "maintainer tools",
    "developer tools",
  ],
  authors: [{ name: "ossgard" }],
  openGraph: {
    title: "ossgard — Duplicate PR Detection",
    description:
      "AI-powered duplicate pull request detection for open-source repositories. Find and resolve redundant PRs before they waste reviewer time.",
    url: "https://ossgard.dev",
    siteName: "ossgard",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "ossgard — Duplicate PR Detection",
    description:
      "AI-powered duplicate pull request detection for open-source repositories.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
