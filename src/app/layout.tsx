import type { Metadata } from "next";
import { Press_Start_2P, Share_Tech_Mono } from "next/font/google";
import "./globals.css";

const pressStart = Press_Start_2P({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400"]
});

const shareTech = Share_Tech_Mono({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400"]
});

export const metadata: Metadata = {
  title: "Talky",
  description: "Talkie-walkie web minimaliste pour 2 personnes."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body className={`${pressStart.variable} ${shareTech.variable}`}>{children}</body>
    </html>
  );
}
