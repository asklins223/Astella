import pino from "pino";
import { safeErrorSerializer } from "@ailearn/shared";
import { createLogCaptureHook } from "./log-buffer.ts";

const usePrettyTransport =
  process.env.NODE_ENV !== "production" &&
  process.env.NODE_TEST_CONTEXT === undefined;

const serializers = {
  err: safeErrorSerializer,
  error: safeErrorSerializer,
  cause: safeErrorSerializer,
};

/**
 * 运维面板的日志页数据源（见 lib/log-buffer.ts）。
 *
 * 钩子挂在 **每一支** logger 上——包括 Fastify 从 `loggerInstance` 派生的
 * 子 logger，所以 `request.log` 的请求日志也会进缓冲。放在这里而不是
 * `server.ts`：`server.ts` 只是消费者，钩子的生命周期必须与 logger 实例
 * 本身相同，否则先创建的 logger 拿不到钩子。
 */
export const loggerOptions: pino.LoggerOptions = {
  ...(usePrettyTransport
    ? {
        level: process.env.LOG_LEVEL ?? "info",
        serializers,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
      }
    : { level: process.env.LOG_LEVEL ?? "info", serializers }),
  hooks: { logMethod: createLogCaptureHook() },
};

export const logger = pino(loggerOptions);