import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StokNet | Donanım Envanter Takip",
  description: "Hırdavat ve donanım envanter takibi için mobil öncelikli hızlı PWA",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "StokNet",
  },
  icons: {
    icon: "/icon-192.svg",
    apple: "/icon-192.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr" className="dark bg-black">
      <body suppressHydrationWarning
        className="bg-black text-zinc-100 min-h-dvh flex flex-col font-sans antialiased selection:bg-amber-500/30 selection:text-amber-200"
      >
        {children}
      </body>
    </html>
  );
}
