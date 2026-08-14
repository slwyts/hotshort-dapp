import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Settings,
  Database,
  Ticket,
  Flame,
  Users,
  Wallet,
  Coins,
  BarChart3,
  Wrench,
  ArrowDownUp,
} from "lucide-react";

const sections = [
  { href: "/admin/rates", icon: Settings, title: "收益率管理", desc: "设置各资产的月化收益率" },
  { href: "/admin/genesis", icon: Database, title: "节点名单", desc: "按套餐等级查看和导入参与钱包" },
  { href: "/admin/stock-price", icon: Coins, title: "股价管理", desc: "自动同步与手动兜底价格" },
  { href: "/admin/ai-config", icon: BarChart3, title: "AI 量化", desc: "每日交易模拟与分红池配置" },
  { href: "/admin/agents", icon: Users, title: "代理商", desc: "团队数据与返佣统计" },
  { href: "/admin/stock-sales", icon: ArrowDownUp, title: "股票买卖", desc: "FXHO 买入/卖出与到账记录" },
  { href: "/admin/lottery", icon: Ticket, title: "彩票管理", desc: "门票定价与开奖" },
  { href: "/admin/airdrop", icon: Flame, title: "版权空投", desc: "燃烧 HS 价值满 1000U 用户的空投发放管理" },
  { href: "/admin/funds", icon: Wallet, title: "资金与安全", desc: "Vault 余额、暂停、提取" },
  { href: "/admin/advanced-debug", icon: Wrench, title: "高级调试", desc: "时间偏移与数据库重置（测试用）" },
];

export default function AdminHomePage() {
  return (
    <AdminGuard>
      <div className="container mx-auto px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-black neon-text">管理后台</h1>
        <p className="mt-2 text-sm text-white/50">仅管理员钱包可访问</p>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((s) => (
            <a key={s.href} href={s.href}>
              <Card className="group h-full transition-all duration-200 hover:-translate-y-1 hover:border-[#b829ff]/40 hover:shadow-[0_0_20px_rgba(184,41,255,0.15)]">
                <CardHeader>
                  <CardTitle className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#00c6ff]/20 to-[#b829ff]/20 transition-colors group-hover:from-[#00c6ff]/30 group-hover:to-[#b829ff]/30">
                      <s.icon className="h-5 w-5 text-[#00c6ff]" />
                    </div>
                    <span className="text-lg">{s.title}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-white/50">{s.desc}</p>
                </CardContent>
              </Card>
            </a>
          ))}
        </div>
      </div>
    </AdminGuard>
  );
}
