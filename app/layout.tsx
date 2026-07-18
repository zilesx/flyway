import type { Metadata } from "next";
import "./globals.css";
import "./iteration.css";
import "./security.css";
import "./admin-settings.css";
import "./trust-features.css";
import "./content-tools.css";

export const metadata: Metadata = {
  title: "Flyway — Private Duck Activity",
  description: "Share fresh duck activity without giving away your hunting spot.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
