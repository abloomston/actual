import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Default destination for OpenRouter call diagnostics.
 *
 * The categorization plugins run inside the Node API host process — the MCP
 * server (`scripts/actual-node-client/mcp-server.mjs`) is the one that matters
 * day to day — where stdout/stderr belong to the transport and are awkward to
 * read. A fixed file in the temp directory is therefore the only place a
 * caller can look without reconfiguring anything, which is the point: judge
 * calls that silently return no category or fail with an opaque message can be
 * traced after the fact.
 */
export const DEFAULT_OPENROUTER_LOG_FILE = '/tmp/actual-openrouter.log';

/**
 * Overrides {@link DEFAULT_OPENROUTER_LOG_FILE}. Set it to `off` (or an empty
 * value) to disable file logging entirely, or to a path to move the log.
 */
export const OPENROUTER_LOG_FILE_ENV_VAR = 'ACTUAL__OPENROUTER_LOG_FILE';

/**
 * Opt-in logging of request/response payloads. Off by default: prompts contain
 * payees, notes and raw synced data, and the log file sits in a shared temp
 * directory where any local process can read it.
 */
export const OPENROUTER_LOG_CONTENT_ENV_VAR = 'ACTUAL__OPENROUTER_LOG_CONTENT';

/** The log is rotated once to `<file>.1` when it would exceed this size. */
export const DEFAULT_OPENROUTER_LOG_MAX_BYTES = 2 * 1024 * 1024;

const MAX_STRING_CHARS = 1024;
const MAX_ERROR_CHARS = 4000;
const MAX_PREVIEW_CHARS = 500;
const MAX_ARRAY_ITEMS = 16;
const MAX_OBJECT_KEYS = 32;
const MAX_NESTING_DEPTH = 3;

const DISABLED_FLAG_VALUES = new Set([
  '',
  '0',
  'disable',
  'disabled',
  'false',
  'none',
  'off',
]);

const REDACTION = '[redacted-secret]';

const SECRET_RULES: {
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}[] = [
  // OpenRouter keys (`sk-or-v1-…`), Anthropic keys and generic `sk-…` tokens.
  {
    pattern: /\bsk-[A-Za-z0-9_\-.]{6,}/g,
    replace: () => REDACTION,
  },
  // `Authorization: Bearer <token>` echoed inside an error body.
  {
    pattern: /\b(bearer|authorization|x-api-key)(\s*[:=]\s*)\S+/gi,
    replace: (_match, prefix: string, separator: string) =>
      `${prefix}${separator}${REDACTION}`,
  },
  // JSON-serialized credentials.
  {
    pattern:
      /"(apiKey|api_key|authorization|password|token)"(\s*:\s*)"[^"]*"/gi,
    replace: (_match, key: string, separator: string) =>
      `"${key}"${separator}"${REDACTION}"`,
  },
];

export type OpenRouterLogLevel = 'info' | 'warn' | 'error';

/** The two kinds of OpenRouter request the plugins make. */
export type OpenRouterLogKind = 'chat' | 'embedding';

export type OpenRouterLogFields = Record<string, unknown>;

export type OpenRouterLogEntry = {
  ts: string;
  level: OpenRouterLogLevel;
  event: string;
  pid: number;
  seq: number;
  callId?: string;
  durationMs?: number;
  [key: string]: unknown;
};

/** Handle for one in-flight request: correlates the lines it produces. */
export type OpenRouterCallLog = {
  readonly callId: string;
  succeed(fields?: OpenRouterLogFields): OpenRouterLogEntry | null;
  fail(error: unknown, fields?: OpenRouterLogFields): OpenRouterLogEntry | null;
};

export type OpenRouterLogger = {
  /** Resolved log path, or `null` when logging is disabled. */
  readonly file: string | null;
  readonly enabled: boolean;
  /** Whether request/response payloads may be written to the log. */
  readonly logContent: boolean;
  log(
    event: string,
    fields?: OpenRouterLogFields,
    level?: OpenRouterLogLevel,
  ): OpenRouterLogEntry | null;
  start(
    kind: OpenRouterLogKind,
    fields?: OpenRouterLogFields,
  ): OpenRouterCallLog;
  /** Payload preview, or `undefined` unless content logging is enabled. */
  preview(value: unknown): string | undefined;
};

export type OpenRouterLoggerOptions = {
  /** Log path, or `false` to disable. Defaults to the env var, then `/tmp`. */
  file?: string | false;
  env?: Record<string, string | undefined>;
  logContent?: boolean;
  maxBytes?: number;
  /** Injected for tests; the default appends to the log file on disk. */
  append?: (file: string, line: string, maxBytes: number) => void;
  now?: () => number;
  pid?: number;
};

function disabledFlag(value: string): boolean {
  return DISABLED_FLAG_VALUES.has(value.trim().toLowerCase());
}

/**
 * Resolves where diagnostics are written: the explicit option wins, then
 * `ACTUAL__OPENROUTER_LOG_FILE`, then {@link DEFAULT_OPENROUTER_LOG_FILE}. The
 * env var doubles as the off switch (`off`, `false`, `0`, …).
 */
export function resolveOpenRouterLogFile(
  options: {
    file?: string | false;
    env?: Record<string, string | undefined>;
  } = {},
): string | null {
  const env = options.env ?? process.env;
  if (options.file === false) {
    return null;
  }
  if (typeof options.file === 'string' && !disabledFlag(options.file)) {
    return options.file.trim();
  }

  const fromEnv = env[OPENROUTER_LOG_FILE_ENV_VAR];
  if (fromEnv !== undefined) {
    return disabledFlag(fromEnv) ? null : fromEnv.trim();
  }

  return DEFAULT_OPENROUTER_LOG_FILE;
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return !disabledFlag(value);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

function redactSecrets(value: string): string {
  let redacted = value;
  for (const { pattern, replace } of SECRET_RULES) {
    redacted = redacted.replace(pattern, replace);
  }
  return redacted;
}

function safeString(value: unknown): string {
  try {
    return typeof value === 'string' ? value : String(value);
  } catch {
    return '[unstringifiable value]';
  }
}

/**
 * Readable form for a bounded payload preview: structured content becomes JSON
 * instead of `[object Object]`.
 */
function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value) ?? safeString(value);
    } catch {
      return safeString(value);
    }
  }
  return safeString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case 'string':
      return redactSecrets(truncate(value, MAX_STRING_CHARS));
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'boolean':
      return value;
    case 'function':
    case 'symbol':
    case 'undefined':
      return undefined;
    default:
      break;
  }

  if (value instanceof Error) {
    return describeError(value);
  }
  if (depth >= MAX_NESTING_DEPTH) {
    return '[object]';
  }
  if (Array.isArray(value)) {
    // Vectors and long lists must not bloat a log line.
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => sanitizeValue(item, depth + 1));
    return value.length > MAX_ARRAY_ITEMS
      ? { itemCount: value.length, items }
      : items;
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(
      0,
      MAX_OBJECT_KEYS,
    )) {
      const sanitized = sanitizeValue(entry, depth + 1);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
    return result;
  }
  return redactSecrets(truncate(safeString(value), MAX_STRING_CHARS));
}

function sanitizeFields(
  fields: OpenRouterLogFields | undefined,
): OpenRouterLogFields {
  const result: OpenRouterLogFields = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    const sanitized = sanitizeValue(value, 0);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  return result;
}

/**
 * Turns any thrown value into loggable fields, including the HTTP status and
 * response body the OpenRouter SDK attaches to its error classes — the parts
 * that explain a rejected request (missing ZDR endpoint, bad key, no credits).
 */
export function describeError(error: unknown): OpenRouterLogFields {
  if (!(error instanceof Error)) {
    return {
      name: 'UnknownError',
      message: redactSecrets(truncate(safeString(error), MAX_ERROR_CHARS)),
    };
  }

  const described: OpenRouterLogFields = {
    name: error.name,
    message: redactSecrets(truncate(error.message, MAX_ERROR_CHARS)),
  };
  const withStatus = error as Error & {
    statusCode?: unknown;
    status?: unknown;
    body?: unknown;
    contentType?: unknown;
  };
  const statusCode = withStatus.statusCode ?? withStatus.status;
  if (typeof statusCode === 'number') {
    described.statusCode = statusCode;
  }
  if (typeof withStatus.body === 'string' && withStatus.body !== '') {
    described.responseBody = redactSecrets(
      truncate(withStatus.body, MAX_ERROR_CHARS),
    );
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause !== error) {
    described.cause = {
      name: cause.name,
      message: redactSecrets(truncate(cause.message, MAX_ERROR_CHARS)),
    };
  }
  return described;
}

/**
 * Single-use rotation: the current log moves to `<file>.1` so the newest
 * diagnostics always survive. Returns whether the file moved.
 */
function rotateIfNeeded(
  file: string,
  incomingBytes: number,
  maxBytes: number,
): boolean {
  try {
    const size = statSync(file).size;
    if (size + incomingBytes <= maxBytes) {
      return false;
    }
  } catch {
    // No log file yet.
    return false;
  }
  try {
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

function appendToFile(file: string, line: string, maxBytes: number): void {
  // Logging is diagnostics only: a bad path, a full disk or a missing temp
  // directory must never break transaction categorization.
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    // The directory already exists, or is not creatable; the append below
    // reports that failure.
  }
  try {
    rotateIfNeeded(file, Buffer.byteLength(line, 'utf8'), maxBytes);
    // The temp directory is shared, so the file is created owner-read/write
    // only. Previews of prompts and responses are opt-in, but the routing
    // metadata already describes a user's budget activity.
    appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Ignored by design.
  }
}

export function createOpenRouterLogger(
  options: OpenRouterLoggerOptions = {},
): OpenRouterLogger {
  const env = options.env ?? process.env;
  const file = resolveOpenRouterLogFile({ file: options.file, env });
  const logContent =
    options.logContent ??
    readBooleanEnv(env[OPENROUTER_LOG_CONTENT_ENV_VAR], false);
  const maxBytes = options.maxBytes ?? DEFAULT_OPENROUTER_LOG_MAX_BYTES;
  const append = options.append ?? appendToFile;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;

  let sequence = 0;
  let calls = 0;

  function write(
    level: OpenRouterLogLevel,
    event: string,
    fields: OpenRouterLogFields | undefined,
    callId: string | undefined,
    startedAt: number | undefined,
  ): OpenRouterLogEntry | null {
    if (file === null) {
      return null;
    }
    sequence += 1;
    const entry: OpenRouterLogEntry = {
      ts: new Date(now()).toISOString(),
      level,
      event,
      pid,
      seq: sequence,
      ...(callId === undefined ? {} : { callId }),
      ...(startedAt === undefined
        ? {}
        : { durationMs: Math.max(0, now() - startedAt) }),
      ...sanitizeFields(fields),
    };

    let line: string;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch {
      return null;
    }
    try {
      append(file, line, maxBytes);
    } catch {
      // Diagnostics never break the request being logged.
    }
    return entry;
  }

  return {
    file,
    enabled: file !== null,
    logContent,
    log: (event, fields, level = 'info') =>
      write(level, event, fields, undefined, undefined),
    start: (kind, fields) => {
      calls += 1;
      const callId = `${pid}:${calls}`;
      const startedAt = now();
      write('info', `${kind}.request`, fields, callId, undefined);
      return {
        callId,
        succeed: extraFields =>
          write('info', `${kind}.response`, extraFields, callId, startedAt),
        fail: (error, extraFields) =>
          write(
            'error',
            `${kind}.error`,
            { ...extraFields, error: describeError(error) },
            callId,
            startedAt,
          ),
      };
    },
    preview: value =>
      logContent
        ? redactSecrets(truncate(stringifyValue(value), MAX_PREVIEW_CHARS))
        : undefined,
  };
}
