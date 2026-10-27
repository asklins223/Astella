export const DEFAULT_AVATARS = [
  { id: "smile", label: "微笑" }, { id: "happy", label: "开心" },
  { id: "wink", label: "眨眼" }, { id: "shy", label: "害羞" },
  { id: "surprised", label: "惊讶" },
] as const;
export type AvatarPresetId = typeof DEFAULT_AVATARS[number]["id"];
export type RegistrationAvatarChoice = { preset: AvatarPresetId; file: File | null };

export function randomAvatarChoice(): RegistrationAvatarChoice {
  return { preset: DEFAULT_AVATARS[Math.floor(Math.random() * DEFAULT_AVATARS.length)].id, file: null };
}
export function avatarPresetURL(id: AvatarPresetId): string {
  return new URL(`assets/default-avatars/dafeiyu-${id}.png`, document.baseURI).href;
}
export async function avatarPresetFile(id: AvatarPresetId): Promise<File> {
  const response = await fetch(avatarPresetURL(id));
  if (!response.ok) throw new Error("默认头像没有读取成功，请重新选择或上传照片。");
  return new File([await response.blob()], `dafeiyu-${id}.png`, { type: "image/png" });
}
export function avatarFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("头像没有读取成功，请重新选择。"));
    reader.readAsDataURL(file);
  });
}
