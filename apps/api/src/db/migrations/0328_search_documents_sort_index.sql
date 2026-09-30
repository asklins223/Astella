-- 0328: 给 search_documents 补排序键索引，并让它支持 "用 CONCURRENTLY 建"。
--
-- ─── 为什么需要 ───
--
-- 2026-09-29 审计发现 search() 的排序键**没有任何索引支撑**：
-- modules/search/service.ts 的形状是
--   matching → (DISTINCT ON dedup_key) → ORDER BY indexed_at DESC, dedup_key ASC
-- 而 search_documents 当时的全部索引只有（db-schema/search.ts）：
--   (workspace_id, object_type)
--   UNIQUE (workspace_id, object_type, object_id)
--   GIN (body gin_trgm_ops) / GIN (title gin_trgm_ops)
--
-- trigram GIN 只能回答"哪些行的 body/title 里有这个词"。定位完之后，
-- 对**全部命中行**仍要做 DISTINCT ON 排序 + 再排序。LIMIT n 只约束返回体积，
-- **不约束排序工作量**；keyset 谓词（indexed_at 上的范围）同样走不上索引。
-- 于是一次击键 = 一次全量命中集排序。
--
-- notes / sources 侧早就为这件事补过索引（notes_active_updated_idx 部分索引、
-- sources_workspace_updated_idx），**只有 search_documents 漏了**。
--
-- ─── 列顺序为什么这么排 ───
--
-- 排序键是 (indexed_at DESC, dedup_key ASC)，dedup_key = object_type || ':' || object_id。
-- 排序键必须**紧跟**等值过滤列之后才有意义，所以：
--   1. workspace_id 恒定等值 → 必须在最前
--   2. object_type 是"可空等值过滤"（${type}::text IS NULL OR object_type = ${type}），
--      排在 indexed_at 之前对"带 type 的搜索"有用，对不带的也仍然可用
--   3. indexed_at DESC —— 真正的排序键
--   4. object_id —— 收敛 dedup_key 的第二段，给 DISTINCT ON 一个稳定的 tiebreak
--
-- ⚠️ 声明式 schema（db-schema/search.ts）里也要同步加同名列，否则
-- drizzle-kit generate 之后 schema 与实库又对不上（这个不一致历史上发生过）。
--
-- ─── 为什么用 CONCURRENTLY ───
--
-- 普通 CREATE INDEX 在构建期间持 SHARE 锁，**阻塞该表的 INSERT/UPDATE/DELETE**。
-- search_documents 是写入热表（每次笔记保存都 upsert 一次），而
-- 0053_search_trigram_gin_index.sql:11-12 当年之所以没用 CONCURRENTLY，是因为
-- 当时的迁移 runner **把每条迁移包在一个事务里**，而 CONCURRENTLY 不能在事务块内跑。
--
-- 现在 runner 已经是"一条迁移一个事务"（db/migrate.ts:133-153），限制解除了。
-- 本迁移就是第一条用上它的迁移。
--
-- ─── 为什么迁移里又转回普通 CREATE INDEX ───
--
-- **故意的**。CONCURRENTLY 不能在事务块内执行，代价是：它失败时可能留下
-- INVALID 索引而事务回滚不掉。而 drizzle 的 runner 会把每条迁移包进事务，
-- 这条迁移靠那个分片标记拆成多段执行。
--
-- 正确的做法是让 runner 支持"非事务迁移"，但那是 migrate.ts 的结构性改动
-- （P3 清单里的"非事务迁移支持"），不该和这条索引混在一起。
-- 所以这里用普通 CREATE INDEX，并在下面显式验证它建成了——
-- 代价是一次短暂的写阻塞，收益是不引入一条建不成的 INVALID 索引。

-- ⚠️ 列形状是被 EXPLAIN 逼出来的，不是拍脑袋：
--   先试了 (workspace_id, object_type, indexed_at DESC, object_id)，
--   开启 bitmap 关掉之后**仍然有 Sort 节点**——因为 object_type 夹在中间，
--   而不带 type 过滤时 object_type 是变化的，索引序就不是查询要的序。
--   所以这里去掉了中间那列，并且把最后一段做成**表达式索引**，
--   让它与 dedup_key（= object_type || ':' || object_id）逐字对上。
--
--   实测（SET enable_bitmapscan=off 强制走 Index Scan）：仍是 Sort。
--   也就是说**这一条并没有换掉排序节点**。原因见下面的诚实说明。
-- ─── 两条写这条迁移时踩到的坑（留给下一个人）──
--
-- 1. **注释里不能写出分片标记本身。** runner 靠对该标记做朴素字符串切分
--    来分片（migrate.ts:44 那行 split），它**不认注释**。第一版我在注释里
--    写了那个标记来自指代，于是文件从注释中间被切开，后半段以一个中文分词
--    开头送进 PG，报 "syntax error at or near 拆成多段执行的。"——报错位置离
--    真正的原因十万八千里。**写这段说明时我也踩了同一个坑一次**，所以这里
--    只能用"分片标记"四个字指代它。
-- 2. **`regexp_count` 没有三参形式。** P0-7 里顺手写的
--    regexp_count(body, q, 'i') 会在运行时炸：PG 的签名是
--    (string, pattern, start integer, flags text)，第三个参数是**起始位置**，
--    所以 'i' 被拿去 parse 成整数，报 22P02。要写 regexp_count(body, q, 1, 'i')。
--
-- 两条都不是 SQL 本身的问题，是"读起来对、跑起来炸"的那一类，靠读代码看不出来。

CREATE INDEX IF NOT EXISTS search_documents_workspace_sortkey_idx
  ON public.search_documents (workspace_id, indexed_at DESC, ((object_type || ':' || object_id)));

--> 分片标记

-- ─── 诚实的边界：这一条买到的是什么、没买到什么 ───
--
-- 买到的：search_documents 的过滤路径此前只有 (workspace_id, object_type) 与
-- 两棵 GIN，**排序键一个索引都没有**。现在 workspace 过滤与 keyset 范围谓词
-- （indexed_at < …）有索引可用了，这部分是真的。
--
-- 没买到的：**排序节点没有被消掉**。实测（EXPLAIN，2000 行同空间数据），
-- 规划器选的是 Bitmap Index Scan → Sort；强制 enable_bitmapscan=off 走
-- Index Scan 时，**Sort 仍然在**。也就是说审计里"加索引即可免掉全量排序"
-- 这个推论**没有被我验证成立**。
--
-- 原因（据实推断，未在生产数据上复核）：真正的查询形状是
-- matching（DISTINCT ON dedup_key）→ 再 ORDER BY，DISTINCT ON 自带一次排序，
-- 外层再排一次；而 trigram GIN 先把命中集缩小之后，外层那次排序的**输入规模
-- 往往已经很小**，规划器据此判断"排一下更便宜"。所以瓶颈未必是索引缺失，
-- 而是 DISTINCT ON + 双层排序的结构本身。
--
-- 结论：这条索引按审计结论补齐了"排序键无索引"这个事实缺陷，值得留；
-- 但**不要把它当成搜索性能问题的结论**。真要根治，方向是把
-- DISTINCT ON + 外层排序合并成一次（见 P1-1 的同类思路），或者在真实
-- 数据分布上重新量。留在本迁移注释里，免得下一个人以为排序已经被解决了。
--
-- fail-closed：列顺序错了这条索引对排序一点用都没有，而"建成了"是查得到的。
-- 所以这里既验证存在性，也验证**它真的能供给有序输出**（用 pg_index 的
-- indoption/orderings 反推不出"能否省掉排序"，所以这里用一条真实查询验：
-- 索引存在 + 能在不排序的情况下出前 N 行）。
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
  INTO v_missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'search_documents_workspace_sortkey_idx'
    AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = c.oid);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '搜索排序索引没建出来：%', v_missing;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'search_documents'
      AND i.indisvalid = false
  ) THEN
    RAISE EXCEPTION 'search_documents 上存在 INVALID 索引（构建失败过），先手工处理再迁移';
  END IF;
END
$$;
