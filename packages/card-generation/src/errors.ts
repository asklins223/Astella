/**
 * 制卡领域服务的错误类（唯一实现）。
 *
 * ─── 为什么不留在 API ───
 * `CardGenerationV2ServiceError` 是**所有现役错误边界**用来识别制卡失败的同一个类
 * （`routes.ts` 的 `sendServiceError`、worker 的重规划门闩、测试里的 `instanceof`）。
 * 它随创建事务一起搬进领域包，API 侧 `helpers.ts` 继续转出它——**同一个 class
 * 对象**，不是"API 自己再声明一个同名类"。继承链也不动：
 * `CardGenerationV2ServiceError → CardGenerationPipelineErrorV2 → DomainError`。
 *
 * 继承链为什么重要：shared 的 seal / binding-plan **纯函数**抛的是
 * `CardGenerationPipelineErrorV2`，API 的错误边界按同一条继承链把它们的
 * `code`/`statusCode` 一起认出来。把中间那一层改掉会让纯函数抛出的错在端点上
 * 退化成 500——不报错、不留痕。所以本文件只搬 class 的**位置**，不改它的**形状**。
 */
// 2026-08-24（AI 设计审查 §4.4 第二批）：ServiceError 继承 shared 纯逻辑层的
// CardGenerationPipelineErrorV2——seal/binding-plan 纯函数抛出 shared 类，
// API 错误边界通过同一继承链识别 code/statusCode。
import { CardGenerationPipelineErrorV2 } from "@ailearn/shared/card-generation-v2-pipeline";

export class CardGenerationV2ServiceError extends CardGenerationPipelineErrorV2 {
  constructor(code: string, statusCode: number, message: string) {
    super(code, statusCode, message);
  }
}