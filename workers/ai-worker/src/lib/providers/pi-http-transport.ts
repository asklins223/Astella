import { postSseToPublicEndpoint, type PublicStreamingRequester } from "@astella/shared/public-json-http";
import { ProviderRequestError, ProviderStreamError } from "../provider-request-error.ts";

/** Pi/OpenAI SDK transport backed exclusively by the project's pinned HTTPS gate. */
export function createPiHttpTransport(input: {
  providerId: string;
  endpoint: string;
  request?: PublicStreamingRequester;
}): { fetch: typeof globalThis.fetch; failure?: unknown; close(): void } {
  const active = new Set<() => void>();
  const transport: { fetch: typeof globalThis.fetch; failure?: unknown; close(): void } = {
    close: () => { for (const cancel of active) cancel(); active.clear(); },
    fetch: async (resource, init) => {
      try {
        const request = new Request(resource, init);
        if (request.url !== input.endpoint || request.method !== "POST") {
          throw new Error("Pi attempted an unexpected provider endpoint or method");
        }
        request.signal.throwIfAborted();
        const body: unknown = JSON.parse(await request.text());
        const response = await (input.request ?? postSseToPublicEndpoint)(request.url,
          Object.fromEntries(request.headers), body, request.signal);
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          active.delete(close);
          request.signal.removeEventListener("abort", close);
          response.cancel();
        };
        active.add(close);
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) { close(); request.signal.throwIfAborted(); }
        if (response.status < 200 || response.status >= 300) {
          let text = "";
          let bytes = 0;
          try {
            const decoder = new TextDecoder();
            for await (const chunk of response.body) {
              bytes += chunk.byteLength;
              if (bytes > 1024 * 1024) break;
              text += decoder.decode(chunk, { stream: true });
            }
            text += decoder.decode();
          } finally { close(); }
          let providerCode: string | number | null = null;
          try {
            const parsed = JSON.parse(text) as { error?: { code?: unknown; type?: unknown }; code?: unknown };
            const code = parsed.error?.code ?? parsed.error?.type ?? parsed.code;
            if (typeof code === "string" || typeof code === "number") providerCode = code;
          } catch { /* An upstream HTML error page is never exposed. */ }
          throw new ProviderRequestError({ provider: input.providerId, status: response.status, providerCode });
        }
        const iterator = response.body[Symbol.asyncIterator]();
        let bytes = 0;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              request.signal.throwIfAborted();
              const next = await iterator.next();
              if (next.done) { controller.close(); close(); return; }
              bytes += next.value.byteLength;
              if (bytes > 8 * 1024 * 1024) throw new ProviderStreamError(input.providerId, "stream_too_large");
              controller.enqueue(next.value);
            } catch (error) {
              transport.failure = error;
              controller.error(error);
              close();
            }
          },
          cancel: close,
        });
        return new Response(stream, { status: response.status, headers: { "content-type": "text/event-stream" } });
      } catch (error) {
        transport.failure = error;
        throw error;
      }
    },
  };
  return transport;
}
