-- 0306 —— **首页那一件的「换一个／暂不处理」**（39d W7-4 刀五；39 §12.1）。
--
-- §12.1：「推荐附一句理由，可**换一个**或**暂不处理**。…用户略过后**本次**不反复
-- 推荐同一项。」
--
-- 刀四落了判据（`decideHomeSuggestionV2`），但 `dismissedThisSession` 只是一个**入参**——
-- 没有任何地方写它，所以「换一个」与「暂不处理」这两颗按钮**按下去不落库**，下一刷
-- 首页还会推同一件。
--
-- ## 「本次」是这一刀的全部难点
--
-- 落成**永久**黑名单是最省事的写法，而那恰好是 §12.1 明确**不**要的：她今天不想做
-- "用几个小问题回访这篇笔记"，明天那件事又到期了，首页却再也不提——**建议变成了一个
-- 慢慢烂掉的角落**。落成**不落库**（只在前端内存里）也不行：刷新一次页面就回来了，
-- 而"我说了暂不处理"是**她刚做过的一个决定**，刷新不该撤销它。
--
-- 所以落点必须有**边界**。这里取**日历日**（`day_key`，她的时区），理由是 §9.4 的
-- "本批"边界本来就是"今天"：她今天略过的那一件，明天会重新变成候选，而**要重新推荐
-- 它必须有一个说得出的理由**——而"新的一天"是最省事也最像人话的那一个。
--
-- **不加"因为它变了才解禁"那一档**：`item_key` 变了就是另一项（那由唯一键按
-- `item_key` 分开），而"同一项内容更新了"在候选读侧已经会变 `updatedAt`、进而变档位
-- 与理由——那一档的收益不值一次额外的表。
--
-- 不复用 `daily_review_batches_v2`：那是"今天这一批有多长"的锁，两件事的生命周期与
-- 语义都不同（那一张一天一行，这一张一天可能几十行）。**同类不必同表**。
CREATE TABLE IF NOT EXISTS home_suggestion_dismissals_v2 (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL,
  user_id           uuid NOT NULL,
  day_key           text NOT NULL,
  -- 候选那一项的 key（不是 objectiveId：同一颗目标可能既是未完轮次又是已授权回访，
  -- 而「换一个」换的是**这一项**）。
  item_key          text NOT NULL,
  -- 'swapped' = 「换一个」（这一项退到后面）；'dismissed' = 「暂不处理」（本次不推）。
  -- 两者都只影响**本次**，但屏上要念不同的话：一个是"换一个"，一个是"先不管它"。
  action            text NOT NULL CHECK (action IN ('swapped', 'dismissed')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE home_suggestion_dismissals_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE home_suggestion_dismissals_v2 FORCE ROW LEVEL SECURITY;

-- 一天同一项只记一次：她点两下"暂不处理"不会产生两行，而"换一个"之后再"暂不处理"
-- 应当**升级**那一行而不是并排两行（屏上只念最后一次）。
CREATE UNIQUE INDEX IF NOT EXISTS hsd_v2_ws_user_day_item_uq
  ON home_suggestion_dismissals_v2 (workspace_id, user_id, day_key, item_key);

CREATE INDEX IF NOT EXISTS hsd_v2_ws_user_day_idx
  ON home_suggestion_dismissals_v2 (workspace_id, user_id, day_key);

CREATE POLICY home_suggestion_dismissals_v2_select ON home_suggestion_dismissals_v2
  FOR SELECT USING (workspace_id = current_setting('app.workspace_id')::uuid
                AND user_id      = current_setting('app.user_id')::uuid);
CREATE POLICY home_suggestion_dismissals_v2_insert ON home_suggestion_dismissals_v2
  FOR INSERT WITH CHECK (workspace_id = current_setting('app.workspace_id')::uuid
                     AND user_id      = current_setting('app.user_id')::uuid);
CREATE POLICY home_suggestion_dismissals_v2_update ON home_suggestion_dismissals_v2
  FOR UPDATE USING (workspace_id = current_setting('app.workspace_id')::uuid
                AND user_id      = current_setting('app.user_id')::uuid)
            WITH CHECK (workspace_id = current_setting('app.workspace_id')::uuid
                     AND user_id      = current_setting('app.user_id')::uuid);

COMMENT ON TABLE home_suggestion_dismissals_v2 IS
  '39 §12.1「可换一个或暂不处理…用户略过后**本次**不反复推荐同一项」。按日历日有界：落成永久黑名单正是 §12.1 不要的（明天的到期又会被静默漏掉），只放前端内存则刷新一次就把她的决定撤销了。';
