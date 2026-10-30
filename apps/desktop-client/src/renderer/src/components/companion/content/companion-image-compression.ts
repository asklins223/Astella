import { COMPANION_IMAGE_UPLOAD_TARGET_BYTES_V1 } from "@astella/shared/companion-conversation-contracts";

/** Small originals keep their bytes. Oversized files are prepared locally,
 * before IPC, signing or any object-storage request. */
export async function prepareCompanionUploadImage(file: File): Promise<File> {
  if (file.size <= COMPANION_IMAGE_UPLOAD_TARGET_BYTES_V1) return file;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  try {
    let scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
    for (;;) {
      canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
      canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("image_canvas_unavailable");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.92, 0.84, 0.76, 0.66]) {
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
          result => result ? resolve(result) : reject(new Error("image_encoding_failed")), "image/jpeg", quality));
        if (blob.size <= COMPANION_IMAGE_UPLOAD_TARGET_BYTES_V1) {
          const stem = file.name.replace(/\.[^.]+$/u, "") || "图片";
          return new File([blob], stem + ".jpg", { type: "image/jpeg", lastModified: file.lastModified });
        }
      }
      if (canvas.width === 1 && canvas.height === 1) throw new Error("image_encoding_failed");
      scale *= 0.75;
    }
  } finally {
    bitmap.close();
    canvas.width = 0; canvas.height = 0;
  }
}
