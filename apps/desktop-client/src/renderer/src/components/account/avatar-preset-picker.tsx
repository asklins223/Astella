import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, ImagePlus, X } from "lucide-react";
import { useRoomStore } from "../../app/home/room-store";
import { AVATAR_MAX_BYTES } from "@astella/shared/desktop-ipc-contracts";
import { AvatarCropDialog } from "../surfaces/settings/avatar-crop-dialog";
import { DEFAULT_AVATARS, avatarPresetURL, type AvatarPresetId, type RegistrationAvatarChoice } from "./default-avatars";

export function AvatarPresetPicker(props: {
  selected?: AvatarPresetId | null; disabled?: boolean;
  onSelect: (id: AvatarPresetId) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const reduceMotion = useRoomStore((state) => state.reducedMotion || state.motionMode === "off");
  return <div className="account-avatar-presets__carousel">
    <div className="account-avatar-presets" ref={track} role="group" aria-label="大肥鱼默认头像">
    {DEFAULT_AVATARS.map((preset) => <button key={preset.id} type="button" className="account-avatar-presets__option"
      disabled={props.disabled} aria-pressed={props.selected === preset.id} aria-label={`${preset.label}头像`}
      onClick={() => props.onSelect(preset.id)}>
      <img src={avatarPresetURL(preset.id)} alt="" width={72} height={72} />
      <span>{preset.label}</span>
    </button>)}
    </div>
    <div className="account-avatar-presets__navigation">
      <span>左右滑动，挑一个表情</span>
      <button type="button" aria-label="上一组头像" disabled={props.disabled} onClick={() => track.current?.scrollBy({ left: -192, behavior: reduceMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}><ChevronLeft size={16} /></button>
      <button type="button" aria-label="下一组头像" disabled={props.disabled} onClick={() => track.current?.scrollBy({ left: 192, behavior: reduceMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}><ChevronRight size={16} /></button>
    </div>
  </div>;
}

export function AvatarSourcePicker(props: {
  selected?: AvatarPresetId | null; busy?: boolean; error?: string | null;
  onSelect: (id: AvatarPresetId) => void; onUpload: () => void; onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="account-avatar-source__backdrop" onClick={(event) => {
    if (event.target === event.currentTarget && !props.busy) props.onClose();
  }}>
    <section ref={panel} className="account-avatar-source" role="dialog" aria-modal="true" aria-label="编辑头像"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !props.busy) { event.stopPropagation(); props.onClose(); }
        if (event.key === "Tab") {
          const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
          const first = buttons[0], last = buttons.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="account-avatar-source__heading"><div><span>YOUR AVATAR</span><h2>换个表情，继续拾星</h2></div>
        <button type="button" aria-label="关闭头像选择" disabled={props.busy} onClick={props.onClose}><X size={18} /></button></header>
      <p>选一张大肥鱼头像，或用你自己的照片。</p>
      <AvatarPresetPicker selected={props.selected} disabled={props.busy} onSelect={props.onSelect} />
      {props.error ? <p role="alert">{props.error}</p> : null}
      <button className="account-avatar-source__upload" type="button" aria-label="上传自定义图片" disabled={props.busy} onClick={props.onUpload}>
        <ImagePlus size={21} /><span><strong>上传自定义图片</strong><small>选择照片后，可以拖动、缩放和裁剪</small></span><ChevronRight size={17} />
      </button>
      {props.busy ? <p role="status">正在保存头像…</p> : null}
    </section>
  </div>, document.body);
}

export function RegistrationAvatarPicker(props: {
  value: RegistrationAvatarChoice; disabled: boolean; onChange: (value: RegistrationAvatarChoice) => void;
}) {
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showsSources, setShowsSources] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.value.file) { setPreview(null); return; }
    const url = URL.createObjectURL(props.value.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [props.value.file]);
  return <div className="account-avatar-registration">
    <button className="account-avatar-registration__edit" type="button" aria-label="编辑头像" disabled={props.disabled} onClick={() => setShowsSources(true)}>
      <img className="account-avatar-registration__preview" src={preview ?? avatarPresetURL(props.value.preset)} alt="已选头像" width={112} height={112} />
      <span>编辑头像</span>
    </button>
      <input ref={input} className="settings-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif"
        disabled={props.disabled} onChange={(event) => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
          if (!file) return;
          if (file.size > AVATAR_MAX_BYTES) { setFailure("请选择不超过 10 MB 的图片。"); return; }
          setFailure(null); setCropFile(file);
        }} />
    {showsSources ? <AvatarSourcePicker selected={props.value.file ? null : props.value.preset} onClose={() => setShowsSources(false)}
      onSelect={(preset) => { props.onChange({ preset, file: null }); setFailure(null); setShowsSources(false); }}
      onUpload={() => { setShowsSources(false); input.current?.click(); }} /> : null}
    {failure ? <p role="alert">{failure}</p> : null}
    {cropFile ? <AvatarCropDialog file={cropFile} onCancel={() => { setCropFile(null); input.current?.focus(); }}
      onConfirm={async (file) => { props.onChange({ ...props.value, file }); setCropFile(null); input.current?.focus(); }} /> : null}
  </div>;
}
