-- 0444：去标识的意图语料（服务端一份，跨账号共享）。
--
-- 为什么要有它：L1 放行路由按账号分索引，新装用户 0 条样本 = 永远不放行；而实测
-- （2026-10-18，真实 259 轮留出集）把同一份语料做厚是**唯一**能把"零硬错覆盖"往上抬
-- 的杠杆——冻结向量上训练一个头 AUC 0.90 也没能突破容量，kNN 25.5% / 线性头 22.8%，
-- 差的是样本量不是模型。
--
-- 隐私边界（用户 2026-10-18 批准"存服务端一份去标识库"）：
--   · 不收 workspace_id / user_id，一条样本不与任何账号、会话、轮次相连；
--   · 不存原话正文，只存规范化原话的 sha256 与它自己的向量（与 0443 同一条规矩）；
--   · 只用于"这句话要不要读用户自己的东西"这一个判定，不参与记忆召回或任何检索；
--   · 不进桌面包，只随服务端镜像走。
--
-- source 区分来源：`synthetic` 是按产品口吻生成、由权威解释器打标的样本；
-- `observed` 是**用户明确同意**后从真实轮次投喂的去标识副本。两者在训练与评测里必须
-- 分开：真实轮次只做留出集，绝不用来训练（否则就是自证）。
--> statement-breakpoint
CREATE TABLE public.companion_gate_corpus (
  id uuid PRIMARY KEY,
  text_sha256 char(64) NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  intent text NOT NULL,
  tool_use text NOT NULL,
  source text NOT NULL CHECK (source IN ('synthetic', 'observed')),
  embedding jsonb NOT NULL CHECK (jsonb_typeof(embedding) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX companion_gate_corpus_key_idx
  ON public.companion_gate_corpus(text_sha256, intent, tool_use);
--> statement-breakpoint
-- 语料不是用户数据，不按 workspace 隔离：它只有一份，属全局。
GRANT SELECT, INSERT, UPDATE ON TABLE public.companion_gate_corpus TO astella_worker;
GRANT ALL PRIVILEGES ON TABLE public.companion_gate_corpus TO astella_migrator;
--> statement-breakpoint
COMMENT ON TABLE public.companion_gate_corpus IS
  'De-identified intent corpus shared by all accounts: text digest + labels + embedding only. No account binding, no utterance text.';
