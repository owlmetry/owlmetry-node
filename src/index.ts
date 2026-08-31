import { randomUUID } from "node:crypto";
import { validateConfiguration, type ValidatedConfig } from "./configuration.js";
import { Transport } from "./transport.js";
import {
  SDK_NAME,
  SDK_VERSION,
  type OwlConfiguration,
  type OwlLogLevel,
  type LogEvent,
  type FeedbackSubmission,
  type FeedbackReceipt,
} from "./types.js";
import { OwlOperation } from "./operation.js";
import { AttachmentUploader, type OwlAttachment } from "./attachment-uploader.js";
import { extractErrorAttributes } from "./error-extraction.js";

export type { OwlConfiguration, OwlLogLevel, LogEvent } from "./types.js";
export type { OwlAttachment } from "./attachment-uploader.js";
export { OwlOperation } from "./operation.js";

const MAX_FEEDBACK_MESSAGE_LENGTH = 4000;

export interface SendFeedbackOptions {
  /** Display name the user entered. */
  name?: string;
  /** Email the user entered. Validated server-side. */
  email?: string;
  /**
   * User ID to attach to the feedback row. On a scoped logger this defaults
   * to the scope's userId; pass here to override or set explicitly.
   */
  userId?: string;
  /**
   * UUID session to link to the event timeline. On a scoped logger this
   * defaults to the scope's sessionId; non-UUID values are ignored.
   */
  sessionId?: string;
  /**
   * Bundle ID — only needed when forwarding feedback on behalf of a mobile
   * frontend whose Owlmetry app has a bundle_id set. Backend apps have no
   * bundle_id so this can be omitted.
   */
  bundleId?: string;
  /** Override environment (default: "backend"). Validated server-side. */
  environment?: string;
  /** Override appVersion (default: value from `configure({ appVersion })`). */
  appVersion?: string;
  /** Device model — pass-through when forwarding from a mobile frontend. */
  deviceModel?: string;
  /** OS version — pass-through when forwarding from a mobile frontend. */
  osVersion?: string;
  /** Override isDev (default: value from `configure({ isDev })`). */
  isDev?: boolean;
}

export interface SendFeedbackReceipt {
  id: string;
  createdAt: string;
}

export type { FeedbackSubmission, FeedbackReceipt } from "./types.js";

const MAX_ATTRIBUTE_VALUE_LENGTH = 200;
const MAX_EVENT_MESSAGE_LENGTH = 2000;

// Per-key length overrides for trusted SDK-reserved attributes (always
// underscore-prefixed). Mirrors the server's
// RESERVED_ATTRIBUTE_VALUE_LENGTH_OVERRIDES so stack traces survive the
// SDK's pre-transport trim.
const RESERVED_ATTRIBUTE_VALUE_LENGTH_OVERRIDES: Readonly<Record<string, number>> = {
  _error_stack: 16000,
};
const SLUG_REGEX = /^[a-z0-9-]+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateSessionId(sessionId: string): string | undefined {
  if (!UUID_REGEX.test(sessionId)) {
    if (config?.debug) {
      console.error(
        `Owlmetry: sessionId "${sessionId}" is not a valid UUID and was ignored. Falling back to the default session ID. The server stores session_id as a UUID column — non-UUID values cannot be ingested. The Swift SDK's Owl.sessionId is already a UUID, so forward it verbatim.`,
      );
    }
    return undefined;
  }
  return sessionId;
}
const STEP_MESSAGE_PREFIX = "step:";
/** @deprecated Legacy prefix — kept for console display of old events */
const TRACK_MESSAGE_PREFIX = "track:";

/**
 * Normalize a metric slug to contain only lowercase letters, numbers, and hyphens.
 * Logs a warning if the slug was modified. Returns the normalized slug.
 */
function normalizeSlug(slug: string): string {
  if (SLUG_REGEX.test(slug)) return slug;
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (config?.debug) {
    console.error(
      `Owlmetry: metric slug "${slug}" was auto-corrected to "${normalized}". Slugs should contain only lowercase letters, numbers, and hyphens.`,
    );
  }
  return normalized;
}

function getSourceModule(): string | undefined {
  const err = new Error();
  const stack = err.stack;
  if (!stack) return undefined;

  const lines = stack.split("\n");
  // Skip: Error, at Object.<method> (index.ts), at Owl.<method> / ScopedOwl.<method>
  // Find the first frame outside this file
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes("node:") || line.includes("node_modules")) continue;

    // Extract file:line from "at <something> (file:line:col)" or "at file:line:col"
    const parenMatch = line.match(/\((.+):(\d+):\d+\)$/);
    if (parenMatch) return `${parenMatch[1]}:${parenMatch[2]}`;

    const directMatch = line.match(/at (.+):(\d+):\d+$/);
    if (directMatch) return `${directMatch[1]}:${directMatch[2]}`;
  }

  return undefined;
}

function normalizeAttributes(attrs?: Record<string, unknown>): Record<string, string> | undefined {
  if (!attrs || Object.keys(attrs).length === 0) return undefined;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    let str = String(value);
    const cap = RESERVED_ATTRIBUTE_VALUE_LENGTH_OVERRIDES[key] ?? MAX_ATTRIBUTE_VALUE_LENGTH;
    if (str.length > cap) {
      str = str.slice(0, cap);
    }
    result[key] = str;
  }
  return result;
}

let config: ValidatedConfig | null = null;
let transport: Transport | null = null;
let attachmentUploader: AttachmentUploader | null = null;
let sessionId: string | null = null;
let beforeExitRegistered = false;
let sessionStartedEmitted = false;

// Auto-capture state. Re-entry guard prevents the handler from triggering
// itself if the SDK throws while capturing. `seenErrors` dedupes between the
// unhandledRejection -> uncaughtException escalation in Node's default
// --unhandled-rejections=throw mode (the same error fires twice).
let inCaptureHandler = false;
const seenErrors = new WeakSet<object>();
let uncaughtHandler: ((err: unknown) => void) | null = null;
let rejectionHandler: ((reason: unknown) => void) | null = null;

function ensureConfigured(): { config: ValidatedConfig; transport: Transport; sessionId: string } {
  if (!config || !transport || !sessionId) {
    throw new Error("Owlmetry: not configured. Call Owl.configure() first.");
  }
  return { config, transport, sessionId };
}

function createEvent(
  ctx: { config: ValidatedConfig; sessionId: string },
  level: OwlLogLevel,
  message: string,
  attrs?: Record<string, unknown>,
  userId?: string,
  sessionIdOverride?: string,
): LogEvent {
  const trimmedMessage =
    message.length > MAX_EVENT_MESSAGE_LENGTH ? message.slice(0, MAX_EVENT_MESSAGE_LENGTH) : message;

  return {
    client_event_id: randomUUID(),
    session_id: sessionIdOverride ?? ctx.sessionId,
    ...(userId ? { user_id: userId } : {}),
    level,
    source_module: getSourceModule(),
    message: trimmedMessage,
    custom_attributes: normalizeAttributes(attrs),
    environment: "backend",
    ...(ctx.config.appVersion ? { app_version: ctx.config.appVersion } : {}),
    sdk_name: SDK_NAME,
    sdk_version: SDK_VERSION,
    is_dev: ctx.config.isDev,
    timestamp: new Date().toISOString(),
  };
}

function printToConsole(level: OwlLogLevel, message: string, attrs?: Record<string, unknown>): void {
  if (!config?.consoleLogging) return;
  if (message.startsWith("sdk:")) return;
  if (message.startsWith("metric:") && message.endsWith(":start")) return;

  const tag = level.toUpperCase().padEnd(5);

  let displayMessage: string;
  if (message.startsWith(STEP_MESSAGE_PREFIX)) {
    displayMessage = `step: ${message.slice(STEP_MESSAGE_PREFIX.length)}`;
  } else if (message.startsWith(TRACK_MESSAGE_PREFIX)) {
    // Legacy "track:" prefix from older SDK versions — display as "step:"
    displayMessage = `step: ${message.slice(TRACK_MESSAGE_PREFIX.length)}`;
  } else if (message.startsWith("metric:")) {
    const body = message.slice(7);
    const colonIdx = body.indexOf(":");
    if (colonIdx !== -1) {
      displayMessage = `metric: ${body.slice(0, colonIdx)} ${body.slice(colonIdx + 1)}`;
    } else {
      displayMessage = `metric: ${body}`;
    }
  } else {
    displayMessage = message;
  }

  let line = `🦉  ${tag} ${displayMessage}`;
  if (attrs && Object.keys(attrs).length > 0) {
    const pairs = Object.entries(attrs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    line += ` {${pairs}}`;
  }

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
      break;
  }
}

function trimOrUndefined(value: string | undefined | null): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

async function sendFeedbackInternal(
  message: string,
  options: SendFeedbackOptions = {},
  scopeUserId?: string,
  scopeSessionId?: string,
): Promise<SendFeedbackReceipt> {
  const { config: cfg, transport: tx } = ensureConfigured();

  const trimmedMessage = typeof message === "string" ? message.trim() : "";
  if (!trimmedMessage) {
    throw new Error("Owlmetry: feedback message is required");
  }
  if (trimmedMessage.length > MAX_FEEDBACK_MESSAGE_LENGTH) {
    throw new Error(
      `Owlmetry: feedback message must be at most ${MAX_FEEDBACK_MESSAGE_LENGTH} characters`,
    );
  }

  const submitterName = trimOrUndefined(options.name);
  const submitterEmail = trimOrUndefined(options.email);
  const userId = options.userId ?? scopeUserId;
  const rawSession = options.sessionId ?? scopeSessionId;
  const sessionId = rawSession ? validateSessionId(rawSession) : undefined;

  const body: FeedbackSubmission = {
    message: trimmedMessage,
    is_dev: options.isDev ?? cfg.isDev,
    environment: options.environment ?? "backend",
    sdk_name: SDK_NAME,
    sdk_version: SDK_VERSION,
  };
  if (options.bundleId) body.bundle_id = options.bundleId;
  if (submitterName) body.submitter_name = submitterName;
  if (submitterEmail) body.submitter_email = submitterEmail;
  if (userId) body.user_id = userId;
  if (sessionId) body.session_id = sessionId;
  const appVersion = options.appVersion ?? cfg.appVersion;
  if (appVersion) body.app_version = appVersion;
  if (options.deviceModel) body.device_model = options.deviceModel;
  if (options.osVersion) body.os_version = options.osVersion;

  const receipt = await tx.submitFeedback(body);

  try {
    log(
      "info",
      "sdk:feedback_submitted",
      {
        has_email: submitterEmail ? "true" : "false",
        has_name: submitterName ? "true" : "false",
      },
      userId,
      undefined,
      sessionId,
    );
  } catch {
    // Audit event is best-effort.
  }

  return { id: receipt.id, createdAt: receipt.created_at };
}

function log(
  level: OwlLogLevel,
  message: string,
  attrs?: Record<string, unknown>,
  userId?: string,
  attachments?: OwlAttachment[],
  sessionIdOverride?: string,
): void {
  if (sessionIdOverride !== undefined) {
    sessionIdOverride = validateSessionId(sessionIdOverride);
  }
  try {
    const ctx = ensureConfigured();
    if (!sessionStartedEmitted && !message.startsWith("sdk:")) {
      sessionStartedEmitted = true;
      ctx.transport.enqueue(createEvent(ctx, "info", "sdk:session_started"));
    }
    printToConsole(level, message, attrs);
    const event = createEvent(ctx, level, message, attrs, userId, sessionIdOverride);
    ctx.transport.enqueue(event);
    if (attachments && attachments.length > 0 && attachmentUploader) {
      attachmentUploader.enqueue(event.client_event_id, event.user_id, ctx.config.isDev, attachments);
    }
  } catch (err) {
    if (config?.debug) {
      console.error("Owlmetry:", err);
    }
  }
}

/**
 * A scoped logger instance that automatically tags a user ID and/or a session ID
 * on every event. Create via `Owl.withUser(userId)` or `Owl.withSession(sessionId)`.
 * Scopes chain: `Owl.withSession(sid).withUser(uid)` and vice versa both work.
 *
 * The session scope is typically used in a server handler to link backend events
 * to a client's session — e.g. read an `X-Owl-Session-Id` header sent by the
 * Swift SDK (`Owl.sessionId`) and scope every event in the handler to that value.
 */
export class ScopedOwl {
  private userId?: string;
  private sessionId?: string;

  constructor(userId?: string, sessionId?: string) {
    this.userId = userId;
    this.sessionId = sessionId;
  }

  /** Return a new scope with the given userId, preserving any existing session scope. */
  withUser(userId: string): ScopedOwl {
    return new ScopedOwl(userId, this.sessionId);
  }

  /**
   * Return a new scope with the given sessionId, preserving any existing user scope.
   * `sessionId` should be a UUID string (as produced by `randomUUID()` or the Swift
   * SDK's `Owl.sessionId`). Non-UUID values are silently ignored — the returned
   * scope falls back to the SDK's default session ID — so untrusted client input
   * cannot crash a request handler. Enable `debug: true` on configure to see
   * warnings when invalid values are received.
   */
  withSession(sessionId: string): ScopedOwl {
    return new ScopedOwl(this.userId, validateSessionId(sessionId));
  }

  info(message: string, attrs?: Record<string, unknown>, options?: { attachments?: OwlAttachment[]; sessionId?: string }): void {
    log("info", message, attrs, this.userId, options?.attachments, options?.sessionId ?? this.sessionId);
  }

  debug(message: string, attrs?: Record<string, unknown>, options?: { attachments?: OwlAttachment[]; sessionId?: string }): void {
    log("debug", message, attrs, this.userId, options?.attachments, options?.sessionId ?? this.sessionId);
  }

  warn(message: string, attrs?: Record<string, unknown>, options?: { attachments?: OwlAttachment[]; sessionId?: string }): void {
    log("warn", message, attrs, this.userId, options?.attachments, options?.sessionId ?? this.sessionId);
  }

  error(message: string, attrs?: Record<string, unknown>, options?: { attachments?: OwlAttachment[]; sessionId?: string }): void;
  /**
   * Report an error/exception value. Extracts `_error_type`, `_error_stack`,
   * `Error.cause` chains, AggregateError children, and Node `code/syscall/path`
   * fields into reserved `_error_*` attributes. The server's issue tracker
   * uses `_error_type` as a fingerprint discriminator so different error
   * classes with the same wording stay on separate issues.
   *
   * The `_error_*` namespace is reserved — any caller-provided keys with that
   * prefix are overwritten by the SDK-extracted values to keep fingerprinting
   * and dashboard rendering consistent.
   */
  error(error: Error | unknown, message?: string, attrs?: Record<string, unknown>, options?: { attachments?: OwlAttachment[]; sessionId?: string }): void;
  error(
    messageOrError: string | unknown,
    attrsOrMessage?: Record<string, unknown> | string,
    optionsOrAttrs?: { attachments?: OwlAttachment[]; sessionId?: string } | Record<string, unknown>,
    maybeOptions?: { attachments?: OwlAttachment[]; sessionId?: string },
  ): void {
    logError(this.userId, this.sessionId, messageOrError, attrsOrMessage, optionsOrAttrs, maybeOptions);
  }

  /**
   * Record a named funnel step. Sends an info-level event with message `step:<stepName>`.
   */
  step(stepName: string, attributes?: Record<string, string>): void {
    log("info", `${STEP_MESSAGE_PREFIX}${stepName}`, attributes, this.userId, undefined, this.sessionId);
  }

  /** @deprecated Use `step()` instead. Will be removed in a future version. */
  track(stepName: string, attributes?: Record<string, string>): void {
    this.step(stepName, attributes);
  }

  /**
   * Set custom properties on this user. Properties are merged server-side —
   * existing keys not in this call are preserved. Pass an empty string value
   * to remove a property.
   *
   * Requires a user-scoped instance — throws if the scope has no userId.
   */
  setUserProperties(properties: Record<string, string>): void {
    if (!this.userId) {
      throw new Error("Owlmetry: setUserProperties requires a user-scoped instance. Call .withUser() first.");
    }
    Owl.setUserProperties(this.userId, properties);
  }

  /**
   * Start a tracked operation. The `metric` slug should contain only lowercase letters,
   * numbers, and hyphens (e.g. "photo-conversion", "api-request"). Invalid characters
   * are auto-corrected with a warning logged in debug mode.
   */
  startOperation(metric: string, attrs?: Record<string, unknown>): OwlOperation {
    return new OwlOperation(log, normalizeSlug(metric), attrs, this.userId, this.sessionId);
  }

  /**
   * Record a single-shot metric. The `metric` slug should contain only lowercase letters,
   * numbers, and hyphens (e.g. "onboarding", "checkout"). Invalid characters are
   * auto-corrected with a warning logged in debug mode.
   */
  recordMetric(metric: string, attrs?: Record<string, unknown>): void {
    log("info", `metric:${normalizeSlug(metric)}:record`, attrs, this.userId, undefined, this.sessionId);
  }

  /**
   * Forward user feedback collected from your frontend to Owlmetry. Defaults
   * `user_id` and `session_id` to the scope's values (override via `options`).
   *
   * Throws on failure — wrap calls in try/catch. Empty messages reject
   * synchronously; server-side 4xx responses surface as thrown errors with
   * the server's `error` field in the message.
   */
  async sendFeedback(message: string, options: SendFeedbackOptions = {}): Promise<SendFeedbackReceipt> {
    return sendFeedbackInternal(message, options, this.userId, this.sessionId);
  }
}

/**
 * Shared body for `Owl.error` (top-level, no scope) and `ScopedOwl.error`
 * (scoped to a userId / sessionId). Disambiguates between the string-message
 * overload and the Error-value overload at runtime via `typeof` checks.
 */
function logError(
  userId: string | undefined,
  defaultSessionId: string | undefined,
  messageOrError: string | unknown,
  attrsOrMessage?: Record<string, unknown> | string,
  optionsOrAttrs?: { attachments?: OwlAttachment[]; sessionId?: string } | Record<string, unknown>,
  maybeOptions?: { attachments?: OwlAttachment[]; sessionId?: string },
): void {
  if (typeof messageOrError === "string") {
    const attrs = attrsOrMessage as Record<string, unknown> | undefined;
    const options = optionsOrAttrs as { attachments?: OwlAttachment[]; sessionId?: string } | undefined;
    log("error", messageOrError, attrs, userId, options?.attachments, options?.sessionId ?? defaultSessionId);
    return;
  }
  const userMessage = typeof attrsOrMessage === "string" ? attrsOrMessage : undefined;
  const userAttrs = (typeof attrsOrMessage === "object" ? attrsOrMessage : optionsOrAttrs) as
    | Record<string, unknown>
    | undefined;
  const options = (typeof attrsOrMessage === "object" ? optionsOrAttrs : maybeOptions) as
    | { attachments?: OwlAttachment[]; sessionId?: string }
    | undefined;
  const extracted = extractErrorAttributes(messageOrError, userMessage);
  // SDK-extracted `_error_*` values overwrite any caller-provided ones in the
  // same namespace; non-`_error_*` keys from the caller pass through.
  const merged: Record<string, unknown> = { ...(userAttrs ?? {}), ...extracted.attributes };
  log("error", extracted.message, merged, userId, options?.attachments, options?.sessionId ?? defaultSessionId);
}

function errorOnOwl(message: string, attrs?: Record<string, unknown>, options?: { attachments?: OwlAttachment[]; sessionId?: string }): void;
function errorOnOwl(error: Error | unknown, message?: string, attrs?: Record<string, unknown>, options?: { attachments?: OwlAttachment[]; sessionId?: string }): void;
function errorOnOwl(
  messageOrError: string | unknown,
  attrsOrMessage?: Record<string, unknown> | string,
  optionsOrAttrs?: { attachments?: OwlAttachment[]; sessionId?: string } | Record<string, unknown>,
  maybeOptions?: { attachments?: OwlAttachment[]; sessionId?: string },
): void {
  logError(undefined, undefined, messageOrError, attrsOrMessage, optionsOrAttrs, maybeOptions);
}

/**
 * Capture an unhandled error/rejection into the event stream. Wrapped in
 * try/catch so a SDK failure never compounds the original crash.
 */
function captureUnhandledError(err: unknown, kind: "uncaught_exception" | "unhandled_rejection"): void {
  // Dedupe between the unhandledRejection -> uncaughtException escalation
  // path in Node's default mode. Only object errors can be tracked in a
  // WeakSet — primitives slip through and are captured twice (rare and
  // acceptable).
  if (typeof err === "object" && err !== null) {
    if (seenErrors.has(err)) return;
    seenErrors.add(err);
  }
  try {
    if (!config || !transport || !sessionId) return;
    const extracted = extractErrorAttributes(err);
    const merged: Record<string, string> = { ...extracted.attributes, _unhandled: kind };
    const ctx = { config, sessionId };
    const event = createEvent(ctx, "error", extracted.message, merged);
    transport.enqueue(event);
  } catch (sdkErr) {
    if (config?.debug) {
      console.error("Owlmetry: error capturing unhandled", sdkErr);
    }
  }
}

/**
 * Best-effort flush before a hard crash. Races a real flush against a 200ms
 * timeout so we don't wedge the process indefinitely if the network is slow.
 */
async function flushBeforeCrash(): Promise<void> {
  if (!transport) return;
  const tx = transport;
  await Promise.race([
    tx.flush().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 200)),
  ]);
}

function installUnhandledHandlers(): void {
  if (uncaughtHandler || rejectionHandler) return;
  if (typeof process?.on !== "function") return;

  uncaughtHandler = (err: unknown) => {
    if (inCaptureHandler) return;
    inCaptureHandler = true;
    try {
      captureUnhandledError(err, "uncaught_exception");
    } finally {
      inCaptureHandler = false;
    }
    // Preserve Node's default crash behavior. Registering a uncaughtException
    // handler suppresses the default crash, so if we're the only listener
    // we must explicitly exit(1) after best-effort flush. If the user has
    // their own handler, we step out and let it decide.
    const isOnlyListener = process.listenerCount("uncaughtException") <= 1;
    if (isOnlyListener) {
      flushBeforeCrash().finally(() => {
        // Re-check listenerCount in case the user attached a handler during
        // the async flush window (unlikely but harmless).
        if (process.listenerCount("uncaughtException") <= 1) {
          process.exit(1);
        }
      });
    }
  };

  rejectionHandler = (reason: unknown) => {
    if (inCaptureHandler) return;
    inCaptureHandler = true;
    try {
      captureUnhandledError(reason, "unhandled_rejection");
    } finally {
      inCaptureHandler = false;
    }
    // Same reasoning as uncaughtException: a registered handler suppresses
    // Node's default --unhandled-rejections=throw escalation. If we're the
    // only listener, throw to force the escalation; uncaughtException then
    // runs our other handler (which dedupes via the seenErrors WeakSet)
    // and exits.
    if (process.listenerCount("unhandledRejection") <= 1) {
      throw reason;
    }
  };

  process.on("uncaughtException", uncaughtHandler);
  process.on("unhandledRejection", rejectionHandler);
}

function uninstallUnhandledHandlers(): void {
  if (typeof process?.off !== "function") return;
  if (uncaughtHandler) {
    process.off("uncaughtException", uncaughtHandler);
    uncaughtHandler = null;
  }
  if (rejectionHandler) {
    process.off("unhandledRejection", rejectionHandler);
    rejectionHandler = null;
  }
}

/**
 * Owlmetry Node.js Server SDK.
 *
 * Usage:
 * ```
 * import { Owl } from '@owlmetry/node';
 *
 * Owl.configure({ endpoint: 'https://...', apiKey: 'owl_client_...' });
 * Owl.info('Server started');
 *
 * const owl = Owl.withUser('user_123');
 * owl.info('User logged in');
 *
 * await Owl.shutdown();
 * ```
 */
export const Owl = {
  configure(options: OwlConfiguration): void {
    // Clean up previous transport if reconfiguring
    if (transport) {
      transport.shutdown().catch(() => {});
    }
    config = validateConfiguration(options);
    transport = new Transport(config);
    attachmentUploader = new AttachmentUploader(config);
    sessionId = randomUUID();
    sessionStartedEmitted = false;

    if (!beforeExitRegistered) {
      beforeExitRegistered = true;
      process.on("beforeExit", async () => {
        try {
          if (transport && transport.bufferSize > 0) {
            await transport.flush();
          }
          if (attachmentUploader) {
            await attachmentUploader.flush();
          }
        } catch {
          // Best-effort flush on exit — never crash the host process
        }
      });
    }

    if (config.captureUnhandled) {
      installUnhandledHandlers();
    } else {
      uninstallUnhandledHandlers();
    }
  },

  info(message: string, attrs?: Record<string, unknown>, options?: { attachments?: OwlAttachment[]; sessionId?: string }): void {
    log("info", message, attrs, undefined, options?.attachments, options?.sessionId);
  },

  debug(message: string, attrs?: Record<string, unknown>, options?: { attachments?: OwlAttachment[]; sessionId?: string }): void {
    log("debug", message, attrs, undefined, options?.attachments, options?.sessionId);
  },

  warn(message: string, attrs?: Record<string, unknown>, options?: { attachments?: OwlAttachment[]; sessionId?: string }): void {
    log("warn", message, attrs, undefined, options?.attachments, options?.sessionId);
  },

  error: errorOnOwl,

  /**
   * Record a named funnel step. Sends an info-level event with message `step:<stepName>`.
   */
  step(stepName: string, attributes?: Record<string, string>): void {
    log("info", `${STEP_MESSAGE_PREFIX}${stepName}`, attributes);
  },

  /** @deprecated Use `step()` instead. Will be removed in a future version. */
  track(stepName: string, attributes?: Record<string, string>): void {
    Owl.step(stepName, attributes);
  },

  /**
   * Set custom properties on a user. Properties are merged server-side —
   * existing keys not in this call are preserved. Pass an empty string value
   * to remove a property.
   */
  setUserProperties(userId: string, properties: Record<string, string>): void {
    try {
      const ctx = ensureConfigured();
      ctx.transport.setUserProperties(userId, properties).catch((err) => {
        if (config?.debug) console.error("Owlmetry: setUserProperties failed", err);
      });
    } catch (err) {
      if (config?.debug) console.error("Owlmetry:", err);
    }
  },

  /**
   * Start a tracked operation. The `metric` slug should contain only lowercase letters,
   * numbers, and hyphens (e.g. "photo-conversion", "api-request"). Invalid characters
   * are auto-corrected with a warning logged in debug mode.
   */
  startOperation(metric: string, attrs?: Record<string, unknown>): OwlOperation {
    return new OwlOperation(log, normalizeSlug(metric), attrs);
  },

  /**
   * Record a single-shot metric. The `metric` slug should contain only lowercase letters,
   * numbers, and hyphens (e.g. "onboarding", "checkout"). Invalid characters are
   * auto-corrected with a warning logged in debug mode.
   */
  recordMetric(metric: string, attrs?: Record<string, unknown>): void {
    log("info", `metric:${normalizeSlug(metric)}:record`, attrs);
  },

  /**
   * Return a scoped logger that tags every event with the given userId. The scope
   * can be further narrowed with `.withSession(sessionId)` if needed.
   */
  withUser(userId: string): ScopedOwl {
    return new ScopedOwl(userId);
  },

  /**
   * Return a scoped logger that tags every event with the given sessionId, overriding
   * the SDK's default per-process session ID. Use this in a request handler to link
   * backend events to a client's session — typically by propagating the client's
   * session ID (e.g. Swift SDK `Owl.sessionId`) through a request header.
   *
   * `sessionId` should be a UUID string. Non-UUID values are silently ignored
   * (the returned scope falls back to the SDK's default session ID) so untrusted
   * client input cannot crash a request handler. Enable `debug: true` on configure
   * to see warnings when invalid values are received. Chainable with `.withUser()`.
   */
  withSession(sessionId: string): ScopedOwl {
    return new ScopedOwl(undefined, validateSessionId(sessionId));
  },

  /**
   * Forward user feedback collected from your frontend to Owlmetry.
   *
   * Use this when your own frontend (web form, chat widget, support page)
   * sends feedback to your Node server and you want it captured in the
   * Owlmetry feedback tracker.
   *
   * Throws on failure — wrap calls in try/catch. Empty messages reject
   * synchronously; server-side 4xx responses surface as thrown errors with
   * the server's `error` field in the message.
   *
   * @param message The user's feedback text (trimmed, max 4000 chars).
   * @param options Optional metadata — submitter name/email, user/session IDs, etc.
   * @returns Receipt containing the new feedback id and ISO-8601 createdAt.
   */
  async sendFeedback(message: string, options?: SendFeedbackOptions): Promise<SendFeedbackReceipt> {
    return sendFeedbackInternal(message, options);
  },

  async flush(): Promise<void> {
    if (transport) await transport.flush();
    if (attachmentUploader) await attachmentUploader.flush();
  },

  wrapHandler<TArgs extends unknown[], TReturn>(
    handler: (...args: TArgs) => Promise<TReturn>,
  ): (...args: TArgs) => Promise<TReturn> {
    return async (...args: TArgs): Promise<TReturn> => {
      try {
        return await handler(...args);
      } finally {
        const flushPromise = Owl.flush().catch(() => {});
        const timeoutMs = config?.handlerFlushTimeoutMs === undefined
          ? 500
          : config.handlerFlushTimeoutMs;
        if (timeoutMs === null) {
          await flushPromise;
        } else {
          await new Promise<void>((resolve) => {
            let settled = false;
            const finish = (): void => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              resolve();
            };
            const timeout = setTimeout(finish, timeoutMs);
            void flushPromise.then(finish);
          });
        }
      }
    };
  },

  async shutdown(): Promise<void> {
    uninstallUnhandledHandlers();
    if (transport) {
      if (sessionStartedEmitted) {
        log("info", "sdk:session_ended");
      }
      await transport.shutdown();
      transport = null;
    }
    if (attachmentUploader) {
      await attachmentUploader.flush();
      attachmentUploader = null;
    }
    config = null;
    sessionId = null;
    sessionStartedEmitted = false;
  },
};
