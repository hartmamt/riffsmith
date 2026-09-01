import type { Metadata } from "next";
import { Unbounded, Red_Hat_Mono } from "next/font/google";
import "./globals.css";

const display = Unbounded({ subsets: ["latin"], variable: "--font-display", weight: ["400", "700", "900"] });
const mono = Red_Hat_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500", "700"] });

export const metadata: Metadata = {
  title: "RiffSmith",
  description: "Tab out riffs before you forget them.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
