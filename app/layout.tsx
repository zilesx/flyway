import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flyway — Private Duck Activity",
  description: "Share fresh duck activity without giving away your hunting spot.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
