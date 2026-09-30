# 决策记录 00-3：与 Generation Supervisor 的发布关系确认（§0.3）

> **已废弃（2026-09-29）。** 本文冻结于 2026-08，记录的是被方案 41 取代的学习流程（长轮次、术语化阶段、卡片优先）。下方原有的「Frozen／Confirmed」状态与全部「必须／不得／验收」条款只代表当时记录，**不再是现行约束，不得据以派活或验收**。现行合同：[41 笔记学习](../../../docs/plans/learning-companion/41-note-companion-learning-experience-2026-09-28.md)、[41a 统一 Agent 基础](../../../docs/plans/learning-companion/41a-unified-agent-foundation-2026-09-28.md)、[40 伴星长期体验](../../../docs/plans/learning-companion/40-companion-long-term-experience-and-diary-prd-2026-09-25.md)、[40b 伴星运行时](../../../docs/plans/learning-companion/40b-companion-runtime-and-observability-2026-09-27.md)；不可协商的视觉与陪伴底线见仓库根 `AGENTS.md` 与 `DESIGN.md`。本文与现行合同冲突时一律以现行合同为准；已实施代码按现行产品合同重新核对，不因文档废弃而删除。

> 状态：**Frozen（已冻结）**
> 批准人：Repository Owner（阶段 00 执行指令）
> 日期：2026-08-04
> 来源：`00-decision-and-scope.md` 任务 00-3（原方案 §0.3）
> 约束级别：`PublishedLearningAssetContractV1` 作为消费边界冻结声明；集成 Gate 定义将写入 W0（阶段 01）冻结清单。

---

## 1. 交付物

`PublishedLearningAssetContractV1` 作为**消费边界**的冻结声明。

## 2. 职责分工（原文 §0.3，共 4 条）

1. **职责划分**：Generation Supervisor 负责"什么知识值得成为可信学习资产"；本计划负责"用户如何与这些资产互动并证明理解"。
2. **共享能力与强制分离**：两者可复用通用 Agent Runtime 的 session/turn/tool event/budget/checkpoint/lease/native-tool 能力，但 role、工具权限、数据权限、模型快照和发布 Gate 完全分离。
3. **Learning 侧读取边界**：Learning Session Supervisor 只能读取已确定性 Publish 的 canonical Card/Key Point/Evidence，不得读取 generation draft、Candidate Ledger 私有 staging 或未过 Critic 产物。
4. **Generation 侧读取边界**：Generation Supervisor 不得读取个人回答、音频、理解状态、问题标记或复习表现，也不得为单个用户改写共享卡片。

> 说明：上述第 1、2 条为本计划与 Generation Supervisor 的职责分工；第 3、4 条同时构成数据隔离规则（见 §3）。

## 3. 数据隔离规则

### 3.1 Learning 不得读取生成侧非 Publish 数据

- Learning Session Supervisor 只能读取**已确定性 Publish** 的 canonical Card/Key Point/Evidence。
- 不得读取：generation draft、Candidate Ledger 私有 staging、未过 Critic 产物。

### 3.2 Generation 不得读取个人学习数据

- Generation Supervisor 不得读取：个人回答、音频、理解状态、问题标记、复习表现。
- Generation Supervisor 不得为单个用户改写共享卡片。

## 4. W0 合同工作与 Generation Supervisor 后期 Gate 的并行关系

- W0 合同工作可与 Generation Supervisor 后期 Gate **受控并行**。
- 消费端集成以其 published output contract 稳定为前置，**不反向阻塞**生成主链公测 Gate。

## 5. 消费契约：`PublishedLearningAssetContractV1`（原文完整定义）

```ts
type PublishedLearningAssetContractV1 = {
  contractVersion: "published-learning-asset-v1";
  cardId: string;
  cardRevision: number;
  keyPointId: string;
  claim: string;
  exactEvidenceRefs: string[];
  semanticSupportReportId: string;
  semanticSupportReportHash: string;
  sourceFingerprint: string;
  lifecycle: "active" | "superseded";
  cognitiveType?: string;
  interactionAffordances?: string[];
};
```

## 6. 契约约束

### 6.1 required 字段

required 是 Card（`cardId`/`cardRevision`）、Key Point（`keyPointId`）、claim、exact evidence（`exactEvidenceRefs`）、semantic support（`semanticSupportReportId`/`semanticSupportReportHash`）、source fingerprint（`sourceFingerprint`）和 active/superseded 生命周期（`lifecycle`）。

### 6.2 optional hint 字段

- `cognitiveType` 与 interaction affordance（`interactionAffordances`）只是 optional hint，不是 required。

### 6.3 forbidden 清单与 fallback

- Candidate Ledger、relation hints、private draft 和未 Publish 产物一律 **forbidden**。
- optional 字段缺失时，只使用**通过 Gold 的安全 Scene fallback**。

### 6.4 stale 规则

- active Card Set 被替换或 source fingerprint 改变时，所有**未提交 Episode** stale。
- 历史结果保留原版本引用。

### 6.5 集成 Gate 定义（Generation → Learning）

- contract hash 测试。
- 替换/stale 测试。
- forbidden-field 负向测试。

以上三项是 Generation → Learning 集成 Gate。

## 7. 验收标准

1. 集成 Gate 定义写入 W0（阶段 01）冻结清单。
2. W1 实现 handoff adapter。
