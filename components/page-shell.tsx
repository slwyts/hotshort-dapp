import { cn } from "@/lib/utils";

/**
 * 移动端用户页统一外壳：max-w-md 居中 + 顶部留白 + 底部 pb-24（避开 BottomNav）。
 * Admin 页不要用这个，admin 页保留桌面 container。
 */
export function PageShell({
  children,
  className,
  noPadding,
}: {
  children: React.ReactNode;
  className?: string;
  noPadding?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-md pb-24",
        !noPadding && "px-4 pt-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
