import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-main",
  weight: ["400", "500", "700"]
});

export const metadata: Metadata = {
  title: "Talky",
  description: "Talkie-walkie web minimaliste pour 2 personnes."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body className={spaceGrotesk.variable}>{children}</body>
    </html>
  );
}

