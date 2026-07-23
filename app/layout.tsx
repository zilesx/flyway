import type { Metadata } from "next";
import "./globals.css";
import "./iteration.css";
import "./security.css";
import "./admin-settings.css";
import "./trust-features.css";
import "./content-tools.css";
import "./location-tools.css";
import "./theme.css";
import AppearanceControl from "./appearance-control";

export const metadata: Metadata = {
  title: "FeatherMap — Private Migratory Bird Activity",
  description: "Share fresh migratory bird activity without giving away your exact location.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeScript=`(()=>{try{document.documentElement.dataset.theme=localStorage.getItem('flyway_appearance')||'system'}catch{document.documentElement.dataset.theme='system'}})()`;
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeScript}}/></head><body>{children}<AppearanceControl/></body></html>;
}
