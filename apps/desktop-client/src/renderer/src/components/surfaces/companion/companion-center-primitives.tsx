import { RefreshCw,Search,X } from "lucide-react";
import type { ReactNode } from "react";

export function SectionState({ message, detail, onRetry }: { readonly message: string; readonly detail?: string; readonly onRetry?: () => void }) {
  return <div className="cc-state" role="status"><strong>{message}</strong>{detail ? <p>{detail}</p> : null}{onRetry ? <button type="button" className="cc-link" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />重新读取</button> : null}</div>;
}
export function CenterFeedback({ error, notice }: { readonly error?: string | null; readonly notice?: string | null }) {
  return <>{error ? <p className="cc-feedback is-error" role="alert">{error}</p> : null}{notice ? <p className="cc-feedback" role="status">{notice}</p> : null}</>;
}
export function CenterSearch({ value, onChange, placeholder, label, onSubmit, busy = false }: {
  value: string; onChange: (value: string) => void; placeholder: string; label: string; onSubmit?: () => void; busy?: boolean;
}) {
  const content = <><Search size={16} aria-hidden="true" /><input type="search" value={value} onChange={event => onChange(event.currentTarget.value)} maxLength={onSubmit ? 120 : 200} placeholder={placeholder} aria-label={label} />{value ? <button type="button" aria-label={`清空${label}`} onClick={() => onChange("")}><X size={15} /></button> : null}{onSubmit ? <button type="submit" disabled={busy}>{busy ? "搜索中…" : "搜索"}</button> : null}</>;
  return onSubmit ? <form className="cc-search" onSubmit={event => { event.preventDefault(); onSubmit(); }}>{content}</form> : <label className="cc-search">{content}</label>;
}
export function CenterSection({ title, detail, action, children, className = "" }: { title: string; detail?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`cc-section ${className}`}><header><div><h3>{title}</h3>{detail ? <p>{detail}</p> : null}</div>{action}</header>{children}</section>;
}
