/**
 * 轮次 LLM 协作者的装配（P1-3）。
 *
 * ## 为什么要从路由里搬出来
 *
 * 收口前 `note-learning-rounds/routes.ts` 的函数体开头是这样的：
 *
 * ```ts
 * const modelConfig = resolveTeachingModelConfig();
 * const teaching = options.teaching ?? {
 *   provider: llmTeachingExplainProvider({ config: modelConfig }),
 *   modelId: modelConfig?.model ?? "unconfigured", external: true,
 * };
 * const artifactGenerator = options.artifact ?? {
 *   provider: llmDynamicArtifactProvider({ config: modelConfig }),
 *   modelId: modelConfig?.model ?? "unconfigured",
 * };
 * const targetGrounder = options.targetGrounder ?? createRoundTargetGrounder(modelConfig);
 * ```
 *
 * 路由层因此知道了三件本不该它知道的事：
 *   1. **模型配置从哪来**（`resolveTeachingModelConfig` 读环境）；
 *   2. **"未配置"用什么字面量表示**（`"unconfigured"`）——而且这个字面量在
 *      路由里被**比较了 4 次**（`:652`、`:800`、`:930`、`:937`）；
 *   3. **三个协作者怎么互相配对**（讲解与演示共用同一份 modelConfig，但各自
 *      独立注入，为了让离线用例能造出"讲解成、演示不成"这一种形状）。
 *
 * 第 2 条尤其值得搬：`"unconfigured"` 是个**约定**，而约定散在 4 个比较点上，
 * 意味着改一次就要找 4 处。这里的判据改成 `ready` 这个布尔，调用点不再碰字面量。
 *
 * ## 注入缝保留在哪
 *
 * `noteLearningRoundRoutes(options)` 的三个可注入参数**原样保留**——离线用例
 * 靠它们造形状，搬走会让那些用例全部失效。搬走的是"没注入时怎么造"这一段。
 */

import { llmTeachingExplainProvider, resolveTeachingModelConfig } from "./teaching/teaching-llm.ts";
import { createRoundTargetGrounder, type RoundTargetGrounder } from "./target-grounding.ts";
import type { TeachingExplainProviderV1 } from "./teaching/teaching-explain.ts";
import {
  llmDynamicArtifactProvider,
  type DynamicArtifactProviderV1,
} from "@ailearn/shared/note-dynamic-artifact/round-artifact-model";

/**
 * 一个模型协作者的装配结果。
 *
 * `ready` 取代了原来散在路由里的 `modelId === "unconfigured"` 判断。
 * `modelId` 仍然对外暴露（要写进 generatorRef 与记账），但**"能不能用"由 ready 说**，
 * 调用点不必知道"未配置"是怎么编码的。
 */
export interface RoundModelBinding<TProvider> {
  readonly provider: TProvider;
  readonly modelId: string;
  /** false = 这条链路没有可用模型（配置缺失）。 */
  readonly ready: boolean;
  /** 讲解链路专有：这发是否走外部服务（离线注入时为 false）。 */
  readonly external?: boolean;
}

export interface RoundRuntimeCollaborators {
  readonly teaching: RoundModelBinding<TeachingExplainProviderV1>;
  readonly artifact: RoundModelBinding<DynamicArtifactProviderV1>;
  readonly targetGrounder: RoundTargetGrounder;
}

/** 路由层可注入的离线替身（形状不变，见文件头说明）。 */
export interface RoundRuntimeOverrides {
  teaching?: { provider: TeachingExplainProviderV1; modelId: string; external: boolean };
  artifact?: { provider: DynamicArtifactProviderV1; modelId: string };
  targetGrounder?: RoundTargetGrounder;
}

/** "模型没配"在 modelId 上的编码。**只在本文件里出现**，供下面两处拼装复用。 */
const UNCONFIGURED_MODEL_ID = "unconfigured";

/**
 * 按生产默认值装配三个协作者，并让 `overrides` 逐个顶掉。
 *
 * 逐个顶而不是"整体替换"，是为了保住原有的离线能力：
 * 只注入 `teaching` 时，artifact 与 grounder 仍走生产默认——那正是
 * §6.2「讲解成、演示不成」这类形状的造法。
 */
export function createRoundRuntimeCollaborators(
  overrides: RoundRuntimeOverrides = {},
): RoundRuntimeCollaborators {
  const modelConfig = resolveTeachingModelConfig();
  const configuredModelId = modelConfig?.model ?? UNCONFIGURED_MODEL_ID;

  const teaching = overrides.teaching ?? {
    provider: llmTeachingExplainProvider({ config: modelConfig }),
    modelId: configuredModelId,
    external: true,
  };
  const artifact = overrides.artifact ?? {
    provider: llmDynamicArtifactProvider({ config: modelConfig }),
    modelId: configuredModelId,
  };

  return {
    teaching: {
      provider: teaching.provider,
      modelId: teaching.modelId,
      external: teaching.external,
      ready: teaching.modelId !== UNCONFIGURED_MODEL_ID,
    },
    artifact: {
      provider: artifact.provider,
      modelId: artifact.modelId,
      ready: artifact.modelId !== UNCONFIGURED_MODEL_ID,
    },
    targetGrounder: overrides.targetGrounder ?? createRoundTargetGrounder(modelConfig),
  };
}
