import { ArrowLeft } from "lucide-react";
import { useRoomStore } from "../../../app/room-store";

type SurfaceReturnControlProps = {
  readonly className: string;
  readonly label?: string;
  readonly disabled?: boolean;
};

export function SurfaceReturnControl({ className, label = "返回学习空间", disabled = false }: SurfaceReturnControlProps) {
  const returnTarget = useRoomStore(state => state.returnTarget);
  const invoke = useRoomStore((state) => state.invoke);

  return (
    <button
      className={`surface-return-control ${className}`}
      type="button"
      disabled={disabled}
      onClick={returnTarget?.run ?? (() => invoke("home"))}
      aria-label={returnTarget?.label ?? "关闭任务面并返回学习空间"}
      data-surface-initial-focus="true"
    >
      <ArrowLeft size={17} aria-hidden="true" />
      <span>{returnTarget?.label ?? label}</span>
    </button>
  );
}
