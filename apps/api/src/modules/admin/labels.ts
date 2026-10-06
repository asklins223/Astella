/**
 * 内部代号 → 人话。
 *
 * ## 为什么需要这一层
 *
 * 面板的第一版把内部标识直接摆出来当标题：`astella_http_requests_total`、
 * `companion_memory_extract`、`LEARNING_RUN_ENABLED`、`operational_error:provider:TypeError`。
 * 那些是**开发时**的坐标——排查时你需要它们，**看板上**你不需要。
 *
 * 于是这里给每一个对外出现的标识配一句人话：
 *   `companion_memory_extract` → 记忆提取　「从对话里挑出值得记住的事」
 *   `astella_http_requests_total` → 接口请求　「用户操作触发的服务端调用」
 *
 * 代号**不删**，但降级成次要信息：标题是人话，代号缩在下方或展开处。
 * 一个需要精确对指标名做告警集成的人，仍然能在面板上一眼找到那个标识。
 *
 * ## 为什么放在服务端
 *
 * 文案要跟口径绑在一起。如果前端各写一份，改了采样方式（例如 p95 从全站
 * 改成按路由）而中文说明没跟着改，两边就会各说各话——而这种漂移不会让任何
 * 测试变红。
 */

export interface SeriesMeta {
  key: keyof {
    requestsPerMinute: number | null;
    errorsPerMinute: number | null;
    p95Seconds: number | null;
    eventLoopLagSeconds: number | null;
    heapUsedBytes: number | null;
    poolActive: number | null;
    outboxPending: number | null;
    queuePending: number | null;
  };
  /** 图表标题：人话。 */
  label: string;
  /** 一句话说清它在量什么，以及高了意味着什么。 */
  hint: string;
  /** 数值怎么读。 */
  unit: "rate" | "duration" | "bytes" | "count";
  /** 越高越糟吗。决定曲线用警示色还是中性色。 */
  higherIsWorse: boolean;
}

export const METRIC_SERIES_META: SeriesMeta[] = [
  {
    key: "requestsPerMinute",
    label: "接口请求",
    hint: "每分钟有多少次用户操作打到服务端。持续为 0 通常意味着没人用。",
    unit: "rate",
    higherIsWorse: false,
  },
  {
    key: "errorsPerMinute",
    label: "服务端错误",
    hint: "每分钟返回失败的请求数。非零就值得看一眼，只要不是尖峰就还能接受。",
    unit: "rate",
    higherIsWorse: true,
  },
  {
    key: "p95Seconds",
    label: "响应耗时",
    hint: "95% 的请求快于这个时间。估算值（按直方图桶插值），告警仍以原始指标为准。",
    unit: "duration",
    higherIsWorse: true,
  },
  {
    key: "eventLoopLagSeconds",
    label: "事件循环延迟",
    hint: "主线程被占住多久。持续高于 100ms 说明请求在排队等 CPU。",
    unit: "duration",
    higherIsWorse: true,
  },
  {
    key: "heapUsedBytes",
    label: "内存占用",
    hint: "进程堆的使用量。持续攀升且不回落，通常是某个对象被意外持有。",
    unit: "bytes",
    higherIsWorse: true,
  },
  {
    key: "poolActive",
    label: "数据库连接",
    hint: "当前占用的数据库连接数。贴近池上限就会开始排队。",
    unit: "count",
    higherIsWorse: true,
  },
  {
    key: "queuePending",
    label: "后台任务积压",
    hint: "排队等待执行的任务数。和「最老等待时间」一起看才有意义。",
    unit: "count",
    higherIsWorse: true,
  },
  {
    key: "outboxPending",
    label: "学习结算积压",
    hint: "已提交但还没结算的学习轮次。这个数字涨起来就是「学习卡住了」。",
    unit: "count",
    higherIsWorse: true,
  },
];

/** 后台任务类型：作业种类的人话名。 */
export const JOB_TYPE_LABELS: Record<string, string> = {
  parse_source: "资料解析",
  companion_agent: "伴星回复",
  companion_dialogue: "伴星对话",
  companion_summarizer: "会话摘要",
  companion_daily_summary: "每日回顾",
  companion_thought: "伴星随想",
  companion_memory_extract: "记忆提取",
  companion_memory_embedding_rebuild: "记忆重建",
  companion_memory_organize: "记忆整理",
  note_overview_generate: "笔记概览",
  note_expansion_generate: "笔记拓展",
  note_dynamic_artifact_generate: "动态演示",
  note_annotation_explain: "批注解读",
  card_generation_v2: "学习卡生成",
};

/** 作业终态。 */
export const JOB_STATUS_LABELS: Record<string, string> = {
  pending: "等待中",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  dead: "已停止",
};

/** 作业失败原因（`operational_error` 的 category 段）。 */
export const ERROR_CATEGORY_LABELS: Record<string, string> = {
  provider: "模型服务",
  timeout: "超时",
  database: "数据库",
  authentication: "凭据",
  billing: "额度",
  configuration: "配置",
  validation: "参数校验",
  not_found: "找不到资源",
  aborted: "被取消",
  unknown: "原因不明",
};

/** 高危动作审计。 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "export.workspace": "导出整个空间",
  "export.note": "导出笔记",
  "note.permanent_delete": "彻底删除笔记",
  "workspace.member_removed": "移除成员",
  "workspace.ownership_transferred": "转让所有者",
};

export const AUDIT_TARGET_LABELS: Record<string, string> = {
  workspace: "空间",
  note: "笔记",
  member: "成员",
  workspace_owner: "空间所有者",
};

/**
 * 指标族 → 人话。
 *
 * 只覆盖面板会主动展示的那些；未命中的原样显示标识（而不是猜一个意思）——
 * 猜错的解释比裸露的标识更糟。
 */
export const METRIC_FAMILY_LABELS: Record<string, string> = {
  astella_http_requests_total: "接口请求总数",
  astella_http_errors_5xx_total: "服务端错误总数",
  astella_http_request_duration_seconds: "接口响应耗时",
  astella_readiness_status: "就绪状态",
  astella_db_pool_active_connections: "数据库连接（活跃）",
  astella_db_pool_max_connections: "数据库连接（上限）",
  astella_db_server_connections: "数据库连接（全库）",
  astella_db_transaction_failures_total: "数据库事务失败",
  astella_db_rls_denied_total: "越权访问被拦截",
  astella_db_migration_version: "数据库版本",
  astella_learning_run_processing_outbox_depth: "学习结算积压",
  astella_learning_run_processing_outbox_oldest_pending_age_seconds: "学习结算最老等待",
  astella_learning_run_processing_tick_duration_seconds: "结算批处理耗时",
  astella_learning_run_processing_commands_total: "结算批处理命令",
  astella_learning_run_critic_calls_total: "模型判分",
  astella_learning_run_critic_duration_seconds: "模型判分耗时",
  astella_learning_run_critic_fail_closed_total: "判分失败保守处理",
  astella_maintenance_rows_purged_total: "定期清理行数",
  astella_funnel_events_total: "关键转化事件",
  astella_companion_memory_retrieval_mode_total: "记忆检索方式",
  astella_companion_memory_used_count: "每轮用到的记忆数",
  astella_companion_memory_candidate_total: "记忆候选",
  astella_companion_summary_total: "会话摘要",
  astella_companion_pet_profile_changed_total: "桌宠画像变更",
  astella_dashboard_build_duration_seconds: "首页组装耗时",
  astella_dashboard_empty_with_active_objectives_total: "首页空但有学习目标",
  astella_surface_query_duration_seconds: "目标页查询耗时",
  astella_surface_slow_query_total: "目标页慢查询",
  astella_release_info: "发布信息",
  nodejs_eventloop_lag_seconds: "事件循环延迟",
  nodejs_heap_size_used_bytes: "内存占用",
  process_resident_memory_bytes: "常驻内存",
  process_cpu_user_seconds_total: "CPU 时间（用户态）",
};

/**
 * 能力开关 → 人话。
 *
 * 这里给的是**产品上的说法**，不是环境变量名：`LEARNING_RUN_ENABLED`
 * 对一个用这个系统的人来说不是"能力开关"，而是"能不能在学笔记时答题"。
 */
export const CAPABILITY_LABELS: Record<string, { label: string; detail: string }> = {
  LEARNING_RUN_ENABLED: {
    label: "学习答题",
    detail: "在学笔记里出题、作答、判分并安排复习",
  },
  CARD_GENERATION_V2_ENABLED: {
    label: "学习卡生成",
    detail: "把笔记自动变成可练习的知识卡",
  },
  COMPANION_DIALOGUE_V1_ENABLED: {
    label: "伴星对话",
    detail: "与桌面伴星进行文字交流",
  },
  COMPANION_VOICE_DIALOGUE_V1_ENABLED: {
    label: "伴星语音",
    detail: "与伴星语音交流（需要语音服务）",
  },
  COMPANION_JOURNEY_V2: {
    label: "伴星成长",
    detail: "伴星会主动记住偏好、按时提醒",
  },
  COMPANION_MEMORY_VECTOR_V1: {
    label: "记忆重建",
    detail: "按语义检索长期记忆（不改变对话能否使用）",
  },
  COMPANION_MEMORY_CONTEXT: {
    label: "记忆上下文",
    detail: "伴星能引用过去说过的事",
  },
  COMPANION_PET_PROFILE_V1: {
    label: "桌宠画像",
    detail: "根据相处方式调整伴星的性格",
  },
};

/**
 * 能力键（`vision` / `embedding` / `agent_turn` …）的短名。
 *
 * 与 {@link CAPABILITY_LABELS} 分开：那一组键的是**环境变量名**（决定功能开不开），
 * 这一组键的是**能力名**（决定用哪个模型）。两者字面上会撞——
 * `CARD_GENERATION_V2_ENABLED` 与 `card_generation_v2` 是两回事，
 * 合成一张表会让其中一个悄悄取到另一个的文案。
 */
export const CAPABILITY_KIND_LABELS: Record<string, string> = {
  text_generation: "文字生成",
  vision: "看图",
  agent_turn: "智能体作答",
  companion_fallback: "伴星备用",
  embedding: "向量检索",
  rerank: "结果重排",
  speech_recognition: "语音识别",
  image_generation: "生成图片",
};

/** 取人话名；没有对应说法时**原样返回标识**（见本文件头部的理由）。 */
export function humanize(map: Record<string, string>, id: string | null | undefined): string {
  if (!id) return "—";
  return map[id] ?? id;
}

/** 同上，但带 fallback 文案。 */
export function humanizeOr(map: Record<string, string>, id: string | null | undefined, fallback: string): string {
  if (!id) return fallback;
  return map[id] ?? id;
}