-- 更新清单缓存：服务端下发更新信息与地址后，**最后一次问到的**结果必须活下来。
--
-- 为什么落库而不是留内存：进程重启、容器重建都会把内存丢掉，而丢了就会再去问 GitHub。
-- 这张表让"每个通道最多 5 分钟问一次 GitHub"跨进程与多实例都成立；GitHub 连不上时
-- 还能拿上一次成功的结果顶着，更新因此**不会因为一次断网就问不到**。
--
-- 不是用户数据，不按 workspace 隔离，也不启用 RLS：它只有一份，属全局。
-- 因此没有 policy——sec01 的策略计数是硬断言，凭空加一条 policy 会让全库策略检查变红。
--> statement-breakpoint
CREATE TABLE public.update_manifest_cache (
  channel text PRIMARY KEY CHECK (channel IN ('latest.yml', 'latest-mac.yml')),
  tag text NOT NULL,
  body text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.update_manifest_cache TO astella_api;
