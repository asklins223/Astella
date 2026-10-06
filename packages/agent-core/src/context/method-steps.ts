import type { AgentOperationStatusV1 } from "@astella/shared/agent-contracts";

/**
 * 方案 44 §2（核对到的缺口）：「从已完成运行提议的方法主要按能力目录生成步骤」
 * ——**需要提炼实际做法、错误原因、有效替代和适用条件**。
 *
 * ## 差别在哪
 *
 * 按能力目录生成，得到的是「这类任务大概要做哪几步」；一次真实运行给出的是
 * 「这次**实际**走通了哪几步、哪一步没做成、最后换了什么」。前者对每次运行都一样，
 * 所以它其实没有从这次运行里提炼到任何东西。
 *
 * 这条纯函数把两者分开：
 *   - **步骤只来自真正走通的那条路径**（`succeeded`），按实际顺序；
 *   - **没走通的那些进例外**，并记下替代——这是「错误原因」与「有效替代」，
 *     也是下一次换一种材料时最值钱的那一句。
 *   - 待核对（`outcome_unknown`）不算走通：它可能已经发生了副作用，写进步骤等于
 *     把一次没确认的结果说成做法。
 */

export interface MethodOperationTraceV1 {
  capability: string;
  status: AgentOperationStatusV1;
  error?: string | null;
}

export interface MethodStepPlanV1 {
  /** 走通的那条路径，按实际顺序。 */
  steps: string[];
  /** 没走通的步骤与替代，以及它们为什么没走通。 */
  exceptions: string[];
  /** 有没有值得留下的东西——一条都没有时不该硬凑一条做法。 */
  contributes: boolean;
}

/** 每类能力对应的那一句骨架；具体做法仍要靠真实运行填进顺序与例外里。 */
export type StepRenderer = (capability: string) => string;

/**
 * 从一次运行的真实操作序列里提炼做法。
 *
 * 去重按**能力**而不是按句子：同一能力被调三次也只算一步，否则会把「反复重试」
 * 记成「这个做法分三步」，而那其实是一次返工。
 */
export function planMethodStepsFromRun(input: {
  operations: readonly MethodOperationTraceV1[];
  renderStep: StepRenderer;
  /** 每条做法都带的那句边界，不随来源变化。 */
  baselineException: string;
}): MethodStepPlanV1 {
  const succeeded: string[] = [];
  const seen = new Set<string>();
  for (const operation of input.operations) {
    if (operation.status !== "succeeded") continue;
    if (seen.has(operation.capability)) continue;
    seen.add(operation.capability);
    succeeded.push(input.renderStep(operation.capability));
  }

  const exceptions = [input.baselineException];
  const failed = input.operations.filter(operation => operation.status === "failed");
  const unknown = input.operations.filter(operation => operation.status === "outcome_unknown");
  for (const operation of unknown) {
    // 待核对的结果既不算成、也不算没做成——但下一次照做前必须先核对。
    exceptions.push(
      `${input.renderStep(operation.capability)}：这次结果待核对，副作用可能已经发生但没有确定回执，先核对再决定要不要照做。`,
    );
  }
  for (const operation of failed) {
    const reason = operation.error ? `（${operation.error.slice(0, 120)}）` : "";
    const replacement = succeeded.find(step => step !== input.renderStep(operation.capability));
    exceptions.push(
      `${input.renderStep(operation.capability)} 在这次没有走通${reason}。`
      + (replacement ? `改走了：${replacement}` : "这次没有记录到替代路径，不要默认换个做法就行。"),
    );
  }

  return {
    steps: succeeded,
    exceptions: [...new Set(exceptions)],
    contributes: succeeded.length > 0,
  };
}
