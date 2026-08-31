import type { OwlConfiguration } from "./types.js";

const CLIENT_KEY_PREFIX = "owl_client_";
const MAX_HANDLER_FLUSH_TIMEOUT_MS = 2_147_483_647;

export interface ValidatedConfig {
  endpoint: string;
  apiKey: string;
  serviceName: string;
  appVersion?: string;
  debug: boolean;
  isDev: boolean;
  flushIntervalMs: number;
  flushThreshold: number;
  maxBufferSize: number;
  handlerFlushTimeoutMs?: number | null;
  consoleLogging: boolean;
  captureUnhandled: boolean;
}

export function validateConfiguration(config: OwlConfiguration): ValidatedConfig {
  if (!config.endpoint || typeof config.endpoint !== "string") {
    throw new Error("Owlmetry: endpoint is required");
  }

  let endpoint = config.endpoint;
  // Strip trailing slash
  if (endpoint.endsWith("/")) {
    endpoint = endpoint.slice(0, -1);
  }

  try {
    new URL(endpoint);
  } catch {
    throw new Error(`Owlmetry: invalid endpoint URL: ${endpoint}`);
  }

  if (!config.apiKey || typeof config.apiKey !== "string") {
    throw new Error("Owlmetry: apiKey is required");
  }

  if (!config.apiKey.startsWith(CLIENT_KEY_PREFIX)) {
    throw new Error(`Owlmetry: apiKey must start with "${CLIENT_KEY_PREFIX}"`);
  }

  if (
    config.handlerFlushTimeoutMs !== undefined &&
    config.handlerFlushTimeoutMs !== null &&
    (typeof config.handlerFlushTimeoutMs !== "number" ||
      !Number.isSafeInteger(config.handlerFlushTimeoutMs) ||
      config.handlerFlushTimeoutMs < 0 ||
      config.handlerFlushTimeoutMs > MAX_HANDLER_FLUSH_TIMEOUT_MS)
  ) {
    throw new Error(
      `Owlmetry: handlerFlushTimeoutMs must be an integer from 0 to ${MAX_HANDLER_FLUSH_TIMEOUT_MS}, or null`,
    );
  }

  return {
    endpoint,
    apiKey: config.apiKey,
    serviceName: config.serviceName || "unknown",
    appVersion: config.appVersion,
    debug: config.debug ?? false,
    isDev: config.isDev ?? (process.env.NODE_ENV !== "production"),
    flushIntervalMs: config.flushIntervalMs ?? 5000,
    flushThreshold: config.flushThreshold ?? 20,
    maxBufferSize: config.maxBufferSize ?? 10000,
    handlerFlushTimeoutMs:
      config.handlerFlushTimeoutMs === undefined ? 500 : config.handlerFlushTimeoutMs,
    consoleLogging: config.consoleLogging ?? true,
    captureUnhandled: config.captureUnhandled ?? true,
  };
}
