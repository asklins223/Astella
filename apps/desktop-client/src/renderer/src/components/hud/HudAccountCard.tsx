import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, LogOut, UserRound } from "lucide-react";
import { NO_AVATAR_SRC, useRoomStore, type AccountIdentity } from "../../app/room-store";
import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";
import { signOutCurrentAccount } from "../../app/account-signout";
import { HudBubbleConfirmation, HudBubbleHeader } from "./HudBubbleParts";
import { useTactileSurface } from "../motion/use-tactile-surface";

/**
 * 药丸上的账户按钮与气泡读取同一枚首字印章。
 */
export function accountInitial(identity: AccountIdentity | null): string {
  return Array.from(identity?.displayName?.trim() || identity?.email || "我")[0].toUpperCase();
}

/** 当前账号的头像字节；只有它属于正在登录的这个邮箱时才用。 */
export function accountAvatarSrcFor(
  identity: AccountIdentity | null,
  avatar: { readonly email: string; readonly src: string } | null,
): string | null {
  if (!identity || !avatar || avatar.email !== identity.email || avatar.src === NO_AVATAR_SRC) return null;
  return avatar.src;
}

/**
 * 这张脸的唯一来源。折叠态那颗常驻印章与账户小框读同一份，所以「取头像」这件事
 * 从卡片里提出来：谁先挂载谁来取，取到就发布给房间 store，另一个直接读。
 * （2026-10-06 印章换成头像之前，只有点开小框才会取字节，常驻的那颗只有图标。）
 */
export function useAccountAvatar(): string | null {
  const identity = useRoomStore((state) => state.accountIdentity);
  const avatar = useRoomStore((state) => state.accountAvatar);
  const setAccountAvatar = useRoomStore((state) => state.setAccountAvatar);

  /**
   * 每个邮箱只问一次：取到（含"确认没有头像"）就记在 store 里，同一个邮箱不再发
   * 请求——常驻印章是长期挂载的那一个，`avatar?.email` 这层判断就是它的节流。
   * 取不回时本次不记账，下次挂载再试。
   */
  useEffect(() => {
    if (!identity || avatar?.email === identity.email) return undefined;
    const email = identity.email;
    let active = true;
    void (async () => {
      try {
        const profile = unwrapGatewayResult(
          await window.astella.auth.getProfile({ meta: createRequestMeta() }),
        );
        if (!profile.avatarUrl) {
          if (active) setAccountAvatar({ email, src: NO_AVATAR_SRC });
          return;
        }
        const bytes = unwrapGatewayResult(await window.astella.auth.getAvatar({
          meta: createRequestMeta(),
          request: { version: 1, objectKey: profile.avatarUrl.replace("/api/uploads/", "") },
        }));
        if (active) {
          setAccountAvatar({ email, src: `data:${bytes.mimeType};base64,${bytes.imageBase64}` });
        }
      } catch {
        // 头像取不回不是故障：落回首字母印章，本次不记账，下次挂载再试。
      }
    })();
    return () => { active = false; };
  }, [avatar?.email, identity, setAccountAvatar]);

  return accountAvatarSrcFor(identity, avatar);
}

/**
 * 顶栏药丸上的账户按钮点开的小框：这台设备上是**谁**在登录，以及一条退出登录。
 *
 * 身份、账户设置和本机退出各占一层。退出展开明确的确认与取消，不把同一行变成暗中的二次点击。
 */
export function HudAccountCard({ onOpenAccount, onClose }: {
  readonly onOpenAccount: () => void;
  readonly onClose?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const signOutRef = useRef<HTMLButtonElement>(null);
  const leavingRef = useRef(false);
  const returningFocus = useRef(false);
  const identity = useRoomStore((state) => state.accountIdentity);
  const src = useAccountAvatar();
  const [armed, setArmed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useTactileSurface(rootRef, armed ? "confirm" : "account");
  useLayoutEffect(() => {
    if (!armed && returningFocus.current) { returningFocus.current = false; signOutRef.current?.focus(); }
  }, [armed]);

  // 卡片本身也是键盘事件的产物：把焦点交给卡片，下一次 Tab 落在第一行而不是它背后。
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const signOut = async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    // 这个方法自己消化所有失败结局（换成一句人话留给登录页），不会抛。
    await signOutCurrentAccount();
  };

  const displayName = identity?.displayName?.trim();

  return (
    <div ref={rootRef} className="hud-account-bubble" role="dialog" aria-label="账户" tabIndex={-1}>
      <HudBubbleHeader title="账户" hint="这间书房里的你" icon={<UserRound size={20} />} onClose={onClose} />
      <div className="hud-account-identity">
        {src
          ? <img className="hud-account-identity__avatar" src={src} alt="你的头像" />
          : <span className="hud-account-identity__seal" aria-hidden="true">{accountInitial(identity)}</span>}
        <div className="hud-account-identity__text">
          <b>{displayName || (identity ? "我的账户" : "正在读取账号")}</b>
          <span className="hud-account-identity__email" title={identity?.email}>{identity?.email ?? "正在读取这台设备登录的账号"}</span>
          {!displayName && identity ? <small>给自己取个名字吧</small> : null}
        </div>
      </div>
      <button type="button" className="hud-account-action" disabled={leaving} onClick={onOpenAccount}>
        <span className="hud-account-action__icon" aria-hidden="true"><UserRound size={19} /></span>
        <span><b>账户设置</b><small>头像、显示名与账户安全</small></span>
        <ArrowRight size={16} aria-hidden="true" />
      </button>
      <button
        ref={signOutRef}
        type="button"
        className="hud-account-action"
        data-tone="danger"
        disabled={armed || leaving}
        aria-expanded={armed}
        aria-busy={leaving || undefined}
        onClick={() => setArmed(true)}
      >
        <span className="hud-account-action__icon" aria-hidden="true"><LogOut size={19} /></span>
        <span><b>退出登录</b><small>结束这台设备上的登录</small></span>
        <ArrowRight size={16} aria-hidden="true" />
      </button>
      {armed ? <HudBubbleConfirmation title="退出这台设备？" confirmLabel="确认退出" busy={leaving}
        onConfirm={() => void signOut()} onCancel={() => { returningFocus.current = true; setArmed(false); }}>
        退出不会删除任何学习记录，也不影响其他设备上的登录。
      </HudBubbleConfirmation> : <p className="hud-account-footnote">学习记录会好好留在这里。</p>}
    </div>
  );
}
