import Link from "next/link";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Settings,
  Database,
  Ticket,
  Flame,
  Users,
  Wallet,
  Coins,
  BarChart3,
} from "lucide-react";

const sections = [
  { href: "/admin/rates", icon: Settings, title: "利率配置", desc: "USDT / HS / LP 月化收益率（README §1.3）" },
  { href: "/admin/genesis", icon: Database, title: "创世节点名单", desc: "CSV 上传 + 链上扫描" },
  { href: "/admin/stock-price", icon: Coins, title: "股价手动设值", desc: "非小号股票实时价（README §2.1）" },
  { href: "/admin/ai-config", icon: BarChart3, title: "AI 量化配置", desc: "每日交易额区间 + 分红比例（§2.2）" },
  { href: "/admin/agents", icon: Users, title: "代理商及统计", desc: "三代团队规模 + 累计返佣（§2.4）" },
  { href: "/admin/lottery", icon: Ticket, title: "彩票配置（P3）", desc: "门票价、开奖控制" },
  { href: "/admin/airdrop", icon: Flame, title: "空投表单（P3）", desc: "燃烧 ≥1000U 的 hotshort 账户" },
  { href: "/admin/funds", icon: Wallet, title: "资金归集（P4）", desc: "withdrawTo / setSigner / pause" },
];

export default function AdminHomePage() {
  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-black neon-text">Admin Console</h1>
        <p className="mt-2 text-sm text-white/50">仅 owner 钱包可访问。改动以 README v1.1 为准。</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((s) => (
            <Link key={s.href} href={s.href}>
              <Card className="h-full transition hover:-translate-y-1 hover:border-[#b829ff]/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <s.icon className="h-5 w-5 text-[#00c6ff]" />
                    {s.title}
                  </CardTitle>
                  <CardDescription>{s.desc}</CardDescription>
                </CardHeader>
                <CardContent />
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </AdminGuard>
  );
}
