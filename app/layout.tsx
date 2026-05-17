import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { cookieToInitialState } from "wagmi";
import { config } from "@/lib/web3";
import { Web3Provider } from "@/components/web3-provider";
import { LocaleProvider } from "@/components/locale-provider";
import { SiteHeader } from "@/components/site-header";
import { BottomNav } from "@/components/bottom-nav";
import { ReferralHandler } from "@/components/referral-handler";

import "./globals.css";

export const metadata: Metadata = {
  title: "HOTSHORT — Genesis Node Protocol",
  description:
    "Hotshort 全生态门户：质押、AI 量化版权交易、彩票、燃烧分红。BSC 链上可查，签名领取。",
  icons: { icon: "/favicon.png" },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#050505",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const hdrs = await headers();
  const initialState = cookieToInitialState(config, hdrs.get("cookie"));

  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">
        <LocaleProvider>
          <Web3Provider initialState={initialState}>
            <ReferralHandler />
            <SiteHeader />
            <main className="min-h-[calc(100vh-3.5rem)]">{children}</main>
            <BottomNav />
          </Web3Provider>
        </LocaleProvider>
      </body>
    </html>
  );
}
