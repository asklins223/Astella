import pino from "pino";
import { safeErrorSerializer } from "@astella/shared";

// pino's transport is a worker thread that only unrefs itself once its `ready`
// message arrives. Under heavy parallel test startup that message can land after
// the last test finishes, so the thread keeps the process alive and a fully
// passing suite never exits. Tests do not need pretty output; mirror the API
// logger and skip the transport there.
const usePrettyTransport =
  process.env.NODE_ENV !== "production" &&
  process.env.NODE_TEST_CONTEXT === undefined;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    err: safeErrorSerializer,
    error: safeErrorSerializer,
    aiError: safeErrorSerializer,
    repairError: safeErrorSerializer,
    fetchError: safeErrorSerializer,
  },
  transport: usePrettyTransport
    ? {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
      }
    : undefined,
});
