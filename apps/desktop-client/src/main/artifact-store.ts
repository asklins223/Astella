/**
 * 动态产物的本机落盘口（39d W4-6 刀五；D4 §6、§8）。
 *
 * 读侧在 `index.ts`：`<userData>/artifacts/<id>.html` 由 `protocol.handle` 读出来、组装后
 * 喂给 sandbox iframe。这一层补的是它的**写入方**：渲染层只报一个 id（HTML 不穿 IPC），
 * main 带会话令牌取整份 HTML、按展示面的配额判完，写进**同一个路径**。
 *
 * 三条硬约定：
 *  - 幂等：已在 ⇒ 不重新下载，回真实字节数（`stored: false`）；
 *  - 整份：超配额一律整份拒绝，不截断、不落盘（半份 HTML 在 frame 里只会画成怪东西）；
 *  - 不静默：任何失败（网络、配额、写盘）都抛错。回一个 `stored: false` 会让界面把
 *    "没落下来"读成"已经在了"——那是这份接口最容易犯的错。
 */
import { randomBytes } from "node:crypto";
// `Stats` 只从 `node:fs` 出（`node:fs/promises` 的类型没有转出这个名字，只 import 不自 export）。
import type { Stats } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isArtifactId } from "../shared/artifact-frame";
import { assembleArtifactDocument } from "./artifact-surface";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import type { GatewayErrorCode } from "@astella/shared/desktop-ipc-contracts";

export interface ArtifactStoreDeps {
  /** Electron 的 `app.getPath("userData")`；落点与 `index.ts` 读侧同一个目录（测试里是临时目录）。 */
  readonly userDataDir: string;
  /** 取整份 HTML（真实实现：`DesktopGateway.getNoteLearningRoundArtifactHtml`）。 */
  readonly fetchArtifactHtml: (artifactId: string, requestId?: string) => Promise<string>;
}

export interface EnsureArtifactStoredInput {
  readonly artifactId: string;
  /** 透传给网关：取消／关联用（IPC 层给的是 `meta.requestId`）。 */
  readonly requestId?: string;
}

export interface EnsureArtifactStoredResult {
  /** true = 这一发刚写下去；false = 本来就在（没碰网络）。 */
  readonly stored: boolean;
  /** 这一份在本机的大小（字节）。 */
  readonly bytes: number;
}

/**
 * 落盘失败。`detail` 只进本机日志：跨 IPC 的那一份只过 `code`（与网关其余失败同形状），
 * 但主进程这边必须留下"到底卡在哪一格"，否则一次静默失败在事后只能靠猜。
 */
export class ArtifactStoreFailure extends DesktopGatewayFailure {
  constructor(code: GatewayErrorCode, readonly detail: string) {
    super(code, "user_action");
    this.message = `${code}: ${detail}`;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** 产物在本机的落点；与 `index.ts` 的 `artifactSourcePath` 必须是同一个路径。 */
function artifactTargetPath(userDataDir: string, artifactId: string): string {
  return resolve(userDataDir, "artifacts", `${artifactId}.html`);
}

export async function ensureArtifactStored(
  input: EnsureArtifactStoredInput,
  deps: ArtifactStoreDeps,
): Promise<EnsureArtifactStoredResult> {
  // id 是文件名的唯一来源，形状先收口——"没有 `..`、没有分隔符可写"靠的就是这一条。
  // 这里不另写正则：id 的形状只有 `shared/artifact-frame.ts` 一份。
  if (!isArtifactId(input.artifactId)) {
    throw new ArtifactStoreFailure("validation", `产物 id 不是 uuid 形状，拒绝落盘：${input.artifactId}`);
  }

  const targetPath = artifactTargetPath(deps.userDataDir, input.artifactId);

  let existing: Stats | null = null;
  try {
    existing = await stat(targetPath);
  } catch (error) {
    // 只有"不存在"才是可以继续下载的状态；其余（权限、IO）如实抛出，
    // 当"不存在"读会拿一次注定失败的写去覆盖一个看不清的本机故障。
    if (!isMissingFile(error)) {
      throw new ArtifactStoreFailure("safe_internal_error", `读取产物落点失败：${String(error)}`);
    }
  }
  if (existing) {
    if (!existing.isFile()) {
      throw new ArtifactStoreFailure("safe_internal_error", `产物落点被非文件占用：${targetPath}`);
    }
    return { stored: false, bytes: existing.size };
  }

  const html = await deps.fetchArtifactHtml(input.artifactId, input.requestId);

  // 配额检查**只走 `artifact-surface.ts` 那一份口径**（常量与比较都在那里）：读侧组装时
  // 判的是同一个函数、同一份数字，写与读两边不会各有一套"大小上限"。超限整份拒绝。
  const assembled = assembleArtifactDocument({ artifactId: input.artifactId, content: html });
  if (!assembled.ok) {
    throw new ArtifactStoreFailure("unsupported_contract", `产物超配额（${assembled.reason}）：${assembled.detail}`);
  }

  // 先写同目录临时名再 rename：读侧只认 `<id>.html`，崩溃留下的半份永远不会被读成
  // "已经在了"——那正是"整份产物"这条约定最容易被破坏的地方（写一半的 HTML 也能过配额）。
  const temporaryPath = `${targetPath}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await mkdir(resolve(deps.userDataDir, "artifacts"), { recursive: true });
    await writeFile(temporaryPath, html, "utf8");
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new ArtifactStoreFailure("safe_internal_error", `产物写盘失败：${String(error)}`);
  }

  return { stored: true, bytes: Buffer.byteLength(html, "utf8") };
}
