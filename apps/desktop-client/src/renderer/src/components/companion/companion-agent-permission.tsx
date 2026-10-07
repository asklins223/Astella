import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Eye, Hand, Zap } from "lucide-react";
import type { CompanionAgentPermissionLevel } from "@astella/shared/companion-agent-contracts";
import type { CompanionAccountStateV1 } from "@astella/shared/companion-shell-contracts";
import { createRequestMeta, gatewayErrorMessage, requireWorkspaceEpoch, unwrapGatewayResult } from "../../app/desktop-client";
import { COMPANION_AGENT_PERMISSION_DETAIL, COMPANION_AGENT_PERMISSION_OPTIONS } from "./companion-account-presence";
import { COMPANION_ACCOUNT_CHANGED, publishCompanionAccountChanged } from "./companion-events";

const MENU_WIDTH = 296;
const EDGE = 14;

/**
 * 一档一个形状，而不是同一颗盾牌换个颜色：这三档的差别是「她做之前问不问」，
 * 颜色点要用户先记住红黄绿各自是什么，图标不用。
 * 只看不改 → 先问一句 → 直接去做，三个轮廓本身就是一条递进的线。
 */
const PERMISSION_ICON: Record<CompanionAgentPermissionLevel, typeof Eye> = {
  read_only: Eye,
  guided: Hand,
  full: Zap,
};

/**
 * 「她可以自动做到哪一步」——输入框旁边的就地档位。
 *
 * 这一档决定的是刚刚发生在眼前的事：她要不要先问一句才跳页。既然决定的是
 * 眼前这条链路，入口就不该只在设置页深处——按完跳板回到气泡里再翻设置，
 * 等于让用户自己走一遍「发现问题 → 找不到开关」。
 *
 * 弹层挂在 body 上：气泡那张纸的入场动画带着 `transform`，`position: fixed`
 * 在那 560ms 里会以它为参照系，位置就跟着纸一起弹。
 */
export function CompanionAgentPermissionMenu({ buttonClassName }: { buttonClassName: string }) {
  const [account, setAccount] = useState<CompanionAccountStateV1 | null>(null);
  const [open, setOpen] = useState(false);
  const [menuBox, setMenuBox] = useState<CSSProperties | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selfPublish = useRef(false);

  const load = useCallback(async () => {
    try {
      const epoch = await requireWorkspaceEpoch();
      const overview = unwrapGatewayResult(await window.astella.companion.account.getState({ meta: createRequestMeta(epoch) }));
      setAccount(overview.account);
    } catch {
      // 未登录与匿名房间没有账号级设置，这不是失败：那颗按钮干脆不出现。
      setAccount(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { if (!selfPublish.current) void load(); };
    window.addEventListener(COMPANION_ACCOUNT_CHANGED, refresh);
    return () => window.removeEventListener(COMPANION_ACCOUNT_CHANGED, refresh);
  }, [load]);

  const toggle = () => {
    const next = !open;
    if (next && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const upward = rect.top > window.innerHeight / 2;
      setMenuBox({
        left: Math.max(EDGE, Math.min(rect.left + rect.width / 2 - MENU_WIDTH / 2, window.innerWidth - MENU_WIDTH - EDGE)),
        width: MENU_WIDTH,
        ...(upward
          ? { bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(150, rect.top - EDGE * 2) }
          : { top: rect.bottom + 8, maxHeight: Math.max(150, window.innerHeight - rect.bottom - EDGE * 2) }),
      });
    }
    setError(null);
    setOpen(next);
  };

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onResize = () => setOpen(false);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const choose = async (level: CompanionAgentPermissionLevel) => {
    if (!account || busy) return;
    if (level === (account.agentSettings?.permissionLevel ?? "guided")) { setOpen(false); return; }
    setBusy(true);
    setError(null);
    try {
      const epoch = await requireWorkspaceEpoch();
      const patched = unwrapGatewayResult(await window.astella.companion.account.patchState({
        meta: createRequestMeta(epoch),
        request: { revision: account.revision, agentPermissionLevel: level },
      }));
      setAccount(patched);
      // 设置页与伴星自己都在听这个事件；不广播就会出现「这里已改、那里还是旧档位」。
      // 广播之前先挂上自己的标记：这一次新状态已经在手上，不能再把自己拽回去重读一遍。
      selfPublish.current = true;
      publishCompanionAccountChanged();
      selfPublish.current = false;
      setOpen(false);
    } catch (cause) {
      // 失败要留在这张卡上：CAS 撞车时重新读一遍账号，用户才看得见现在到底是哪档。
      setError(gatewayErrorMessage(cause));
      void load();
    } finally {
      setBusy(false);
    }
  };

  if (!account) return null;
  const current: CompanionAgentPermissionLevel = account.agentSettings?.permissionLevel ?? "guided";
  const currentLabel = COMPANION_AGENT_PERMISSION_OPTIONS.find(([value]) => value === current)?.[1] ?? "分步确认";
  const CurrentIcon = PERMISSION_ICON[current];
  return <>
    <button
      ref={buttonRef}
      type="button"
      className={`${buttonClassName} companion-permission__trigger`}
      onClick={toggle}
      aria-haspopup="menu"
      aria-expanded={open}
      title={`助理权限：${currentLabel}`}
      aria-label={`助理权限：${currentLabel}`}
    >
      <CurrentIcon size={19} />
    </button>
    {open && menuBox ? createPortal(<div
      ref={menuRef}
      className="companion-permission__menu"
      role="menu"
      style={menuBox}
      aria-label="助理权限档位"
    >
      <p className="companion-permission__lead">她可以自动做到哪一步</p>
      {COMPANION_AGENT_PERMISSION_OPTIONS.map(([value, label]) => {
        const Icon = PERMISSION_ICON[value];
        return <button
          key={value}
          type="button"
          role="menuitemradio"
          aria-checked={value === current}
          data-current={value === current || undefined}
          disabled={busy}
          onClick={() => void choose(value)}
        >
          <Icon size={17} aria-hidden="true" />
          <span><strong>{label}</strong><small>{COMPANION_AGENT_PERMISSION_DETAIL[value]}</small></span>
        </button>;
      })}
      {error ? <p className="companion-permission__error" role="alert">{error}</p> : null}
    </div>, document.body) : null}
  </>;
}
