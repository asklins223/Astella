-- 方案 44 §6.4：「**保存完整派生关系**，识别共同原始来源……只算同源依据」。
--
-- 上一轮把去重做在了存储上（同源只留最具体的一条），那是把两件事合成了一件，
-- 而且**删掉了方案明确要求保存的东西**：
--   - 派生关系本身要留着。`astella_propagate_playbook_evidence_change` 正是按
--     `evidence @> [{"memoryId": …}]` 找派生方法，用户遗忘/纠正一条记忆时要让它失效。
--     把记忆引用折掉之后，这条传播路径就断了——用户的遗忘不再传递到派生经验。
--   - 而「同源只算一条」说的是**计数**，不是存储。
--
-- 所以拆开：`evidence` 保完整的派生关系（引用一条不少），另存一份来源归并回执供计数。
ALTER TABLE public.companion_procedural_playbooks
  ADD COLUMN IF NOT EXISTS evidence_origins jsonb;

-- 回执形状：独立来源数、被合并数、每个来源键下原本有几条。
-- 约束只挡明显不合法的形状，不重复 core 的归并逻辑。
ALTER TABLE public.companion_procedural_playbooks
  DROP CONSTRAINT IF EXISTS companion_procedural_playbooks_evidence_origins_check;
ALTER TABLE public.companion_procedural_playbooks
  ADD CONSTRAINT companion_procedural_playbooks_evidence_origins_check
  CHECK (
    evidence_origins IS NULL
    OR (
      jsonb_typeof(evidence_origins) = 'object'
      AND evidence_origins ? 'independentCount'
      AND (evidence_origins->>'independentCount')::integer >= 1
      AND (evidence_origins->>'independentCount')::integer
          <= jsonb_array_length(evidence)
    )
  );

CREATE INDEX IF NOT EXISTS companion_procedural_playbooks_evidence_origins_idx
  ON public.companion_procedural_playbooks (workspace_id, user_id)
  WHERE evidence_origins IS NOT NULL;
