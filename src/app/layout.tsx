import type { Metadata } from "next";
import { Share_Tech_Mono, Rajdhani } from "next/font/google";
import "./globals.css";

const shareTech = Share_Tech_Mono({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400"]
});

const rajdhani = Rajdhani({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "700"]
});

export const metadata: Metadata = {
  title: "Talky",
  description: "Talkie-walkie web minimaliste pour 2 personnes."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body className={`${shareTech.variable} ${rajdhani.variable}`}>{children}</body>
    </html>
  );
}
