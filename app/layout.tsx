import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// Self-hosted fonts (OFL-1.1), Latin subset only: no request to Google at build or run time.
import "@fontsource/pixelify-sans/latin-400.css";
import "@fontsource/pixelify-sans/latin-600.css";
import "@fontsource/pixelify-sans/latin-700.css";
import "@fontsource/silkscreen/latin-400.css";
import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-700.css";
// The one theme file: every colour token lives there (GOAL.md section 1a).
import "./theme.css";

export const metadata: Metadata = {
  title: "Impartly",
  description: "Your newsletters, summarized and read to you.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
