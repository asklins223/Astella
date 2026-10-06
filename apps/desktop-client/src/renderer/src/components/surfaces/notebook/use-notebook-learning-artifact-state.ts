/**
 * 「互动演示」那一簇的 8 个 state：列表、那一份已收好的、任务、以及「确保它存在」的重发凭据。
 *
 * ## 为什么只收 state、不收 handler（2026-09-29）
 *
 * `loadNoteLearningArtifacts` / `startNoteLearningArtifactTask` / `ensureLearningArtifact`
 * 三个 handler 各自要读 `note` / `epochRef` / `reload` / `noteLearningArtifacts` —— 全是页面级。
 * 搬进来就要把这些一起搬，那不是拆分是重新设计。
 *
 * ## 四条不许动
 *
 *  1. **`ensureRevision` 是「重发那一发」的唯一凭据**。它是个**计数器**，不是布尔——
 *     第一次失败设 1、第二次设 2……递增才让 effect 认得出「又该发一次」。
 *  2. **`storedId` 记的是「已经收好的那一份的 artifactId」**，不是「有东西」。
 *     屏上靠它决定**印不印题面**（见 `notebook-learning-artifact-paper`）：
 *     已经收好时再印一遍标题与题面就成了重复。
 *  3. **`tasks` 是任务列表，不是产物列表**。产物在 `rows` 里。
 *  4. **列表 / 任务 / 已收好，三样分三处**。合成一处就会出现「读完列表顺手清了任务」。
 */
import { useState } from "react";
import type { NoteLearningArtifactTaskV1, NoteLearningArtifactV1 } from "@astella/shared/note-learning-artifact-contracts";

export function useNotebookLearningArtifactState() {
  const [learningArtifactRows, setLearningArtifactRows] = useState<{ noteId: string; items: NoteLearningArtifactV1[]; nextCursor: string | null } | null>(null);
  const [learningArtifactLoading, setLearningArtifactLoading] = useState(false);
  const [learningArtifactStoredId, setLearningArtifactStoredId] = useState<string | null>(null);
  const [learningArtifactError, setLearningArtifactError] = useState<string | null>(null);
  const [learningArtifactEnsureRevision, setLearningArtifactEnsureRevision] = useState(0);
  const [learningArtifactTasks, setLearningArtifactTasks] = useState<NoteLearningArtifactTaskV1[]>([]);
  const [learningArtifactTaskError, setLearningArtifactTaskError] = useState<string | null>(null);
  const [learningArtifactTaskStarting, setLearningArtifactTaskStarting] = useState(false);

  return {
    learningArtifactRows, setLearningArtifactRows,
    learningArtifactLoading, setLearningArtifactLoading,
    learningArtifactStoredId, setLearningArtifactStoredId,
    learningArtifactError, setLearningArtifactError,
    learningArtifactEnsureRevision, setLearningArtifactEnsureRevision,
    learningArtifactTasks, setLearningArtifactTasks,
    learningArtifactTaskError, setLearningArtifactTaskError,
    learningArtifactTaskStarting, setLearningArtifactTaskStarting,
  };
}
