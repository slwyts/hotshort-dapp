"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { Wallet, Copy, Loader2 } from "lucide-react";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent } from "@/components/ui/card";
import { useLocale } from "@/components/locale-provider";
import { shortenAddress, cn } from "@/lib/utils";
import Swal from "sweetalert2";

const AssetsSection = dynamic(() => import("@/components/me/assets-section").then((m) => m.AssetsSection), { ssr: false });
const OrdersSection = dynamic(() => import("@/components/me/orders-section").then((m) => m.OrdersSection), { ssr: false });
const TeamSection = dynamic(() => import("@/components/me/team-section").then((m) => m.TeamSection), { ssr: false });
const InviteSection = dynamic(() => import("@/components/me/invite-section").then((m) => m.InviteSection), { ssr: false });
const DocsSection = dynamic(() => import("@/components/me/docs-section").then((m) => m.DocsSection), { ssr: false });
const SettingsSection = dynamic(() => import("@/components/me/settings-section").then((m) => m.SettingsSection), { ssr: false });
const AgentEntryCard = dynamic(() => import("@/components/me/agent-entry-card").then((m) => m.AgentEntryCard), { ssr: false });
const AdminEntryCard = dynamic(() => import("@/components/me/admin-entry-card").then((m) => m.AdminEntryCard), { ssr: false });

const TAB_KEYS = ["assets", "orders", "team", "invite", "docs", "settings"] as const;
type TabKey = (typeof TAB_KEYS)[number];

function MeContent() {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useLocale();
  const tabParam = (search.get("tab") || "assets") as TabKey;
  const tab: TabKey = TAB_KEYS.includes(tabParam) ? tabParam : "assets";

  const { address, isConnected } = useAccount();

  const switchTab = (k: TabKey) => {
    const sp = new URLSearchParams(search.toString());
    sp.set("tab", k);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };

  const copyAddr = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    Swal.fire({
      icon: "success",
      title: t("toast.copied"),
      timer: 1200,
      showConfirmButton: false,
      background: "#141419",
      color: "#fff",
    });
  };

  return (
    <PageShell>
      {/* 用户卡 */}
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex items-center gap-3">
            <div className="me-wallet-avatar h-12 w-12 shrink-0 rounded-full bg-gradient-to-br from-[#00c6ff] to-[#b829ff] p-[2px]">
              <div className="me-wallet-avatar-core flex h-full w-full items-center justify-center rounded-full">
                <Wallet className="me-wallet-avatar-icon h-5 w-5" />
              </div>
            </div>
            <div className="min-w-0 flex-1">
              {isConnected && address ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sm">{shortenAddress(address, 6)}</span>
                    <button onClick={copyAddr} className="rounded p-1 hover:bg-white/5" aria-label={t("wallet.copyAddress")}>
                      <Copy className="h-3.5 w-3.5 text-white/40" />
                    </button>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-[11px] text-green-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]" />
                    {t("wallet.network")}
                  </div>
                </>
              ) : (
                <div className="text-sm text-white/50">{t("wallet.disconnected")}</div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mt-3 space-y-3">
        <AdminEntryCard />
        <AgentEntryCard />
      </div>

      {/* sub-tab — 5 个，横向滚动避免挤 */}
      <div className="my-3 -mx-1 overflow-x-auto">
        <div className="mx-1 flex gap-1 rounded-xl border border-white/5 bg-black/40 p-1">
          {TAB_KEYS.map((k) => (
            <button
              key={k}
              onClick={() => switchTab(k)}
              className={cn(
                "shrink-0 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition",
                tab === k
                  ? "bg-gradient-to-r from-[#00c6ff]/20 to-[#b829ff]/20 text-white shadow-[inset_0_0_0_1px_rgba(184,41,255,0.4)]"
                  : "text-white/50 hover:text-white",
              )}
              style={{ flex: "1 1 0" }}
            >
              {t(`me.subtab.${k}`)}
            </button>
          ))}
        </div>
      </div>

      {/* sub-tab 内容 */}
      <div>
        {tab === "assets" && <AssetsSection />}
        {tab === "orders" && <OrdersSection />}
        {tab === "team" && <TeamSection />}
        {tab === "invite" && <InviteSection />}
        {tab === "docs" && <DocsSection />}
        {tab === "settings" && <SettingsSection />}
      </div>
    </PageShell>
  );
}

export default function MePage() {
  return (
    <Suspense fallback={<PageShell><Loader2 className="mx-auto mt-12 h-6 w-6 animate-spin text-white/40" /></PageShell>}>
      <MeContent />
    </Suspense>
  );
}
