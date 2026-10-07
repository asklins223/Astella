import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Tokenizer } from "@huggingface/tokenizers";

export const DEEPSEEK_TOKENIZER_REVISION = "deepseek-v4.1-flash:2cba9e4";
let deepseek: Promise<Tokenizer> | undefined;
// esbuild emits a CommonJS worker bundle into dist/. The original import.meta
// URL is unavailable there; data remains in src/ next to the copied sources.
const dataDirectory = typeof __dirname === "string"
  ? resolve(__dirname, "../src/lib/model-tokenizers/deepseek-v4.1-flash")
  : fileURLToPath(new URL("./model-tokenizers/deepseek-v4.1-flash", import.meta.url));

/** Plain tokenizer data is bundled and pinned; no runtime download or remote
 * model code. Unsupported model IDs return null so the core uses its bound. */
export async function countModelTextTokens(modelId: string, text: string): Promise<number | null> {
  if (modelId !== "deepseek-v4.1-flash") return null;
  deepseek ??= Promise.all([
    readFile(resolve(dataDirectory, "tokenizer.json"), "utf8"),
    readFile(resolve(dataDirectory, "tokenizer_config.json"), "utf8"),
  ]).then(([model, config]) => new Tokenizer(JSON.parse(model), JSON.parse(config)));
  // Do not use model_max_length as a truncation target: counting must see an
  // over-limit request in full, before the pressure gate decides what to do.
  return (await deepseek).encode(text, { add_special_tokens: false }).ids.length;
}
