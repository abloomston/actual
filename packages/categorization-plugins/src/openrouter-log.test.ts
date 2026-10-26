import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenRouterLogger,
  DEFAULT_OPENROUTER_LOG_FILE,
  describeError,
  OPENROUTER_LOG_CONTENT_ENV_VAR,
  OPENROUTER_LOG_FILE_ENV_VAR,
  resolveOpenRouterLogFile,
} from './openrouter-log';
import type { OpenRouterLogEntry } from './openrouter-log';

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'actual-openrouter-log-'));
}

async function readEntries(file: string): Promise<OpenRouterLogEntry[]> {
  const contents = await readFile(file, 'utf8');
  return contents
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as OpenRouterLogEntry);
}

describe('resolveOpenRouterLogFile', () => {
  it('defaults to the named temp file', () => {
    expect(resolveOpenRouterLogFile({ env: {} })).toBe(
      DEFAULT_OPENROUTER_LOG_FILE,
    );
    expect(DEFAULT_OPENROUTER_LOG_FILE).toBe('/tmp/actual-openrouter.log');
  });

  it('honours the environment override', () => {
    expect(
      resolveOpenRouterLogFile({
        env: { [OPENROUTER_LOG_FILE_ENV_VAR]: '/var/log/actual-or.log' },
      }),
    ).toBe('/var/log/actual-or.log');
  });

  it('disables logging through falsy environment values', () => {
    for (const value of ['', '  ', 'off', 'OFF', 'false', '0', 'disabled']) {
      expect(
        resolveOpenRouterLogFile({
          env: { [OPENROUTER_LOG_FILE_ENV_VAR]: value },
        }),
      ).toBeNull();
    }
  });

  it('lets the explicit option win over the environment, including opt-out', () => {
    const env = { [OPENROUTER_LOG_FILE_ENV_VAR]: '/env/path.log' };
    expect(resolveOpenRouterLogFile({ env, file: '/option/path.log' })).toBe(
      '/option/path.log',
    );
    expect(resolveOpenRouterLogFile({ env, file: false })).toBeNull();
  });
});

describe('createOpenRouterLogger', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  it('appends one JSON line per event to the log file', async () => {
    const file = join(dir, 'calls.log');
    const logger = createOpenRouterLogger({ file });

    expect(logger.enabled).toBe(true);
    expect(logger.file).toBe(file);
    logger.log('plugin.init', { pluginId: 'base', hasApiKey: true });
    logger.log('plugin.init', { pluginId: 'judge' });

    const entries = await readEntries(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      level: 'info',
      event: 'plugin.init',
      pluginId: 'base',
      hasApiKey: true,
      seq: 1,
    });
    expect(entries[1]).toMatchObject({ pluginId: 'judge', seq: 2 });
    expect(new Date(entries[0].ts).toString()).not.toBe('Invalid Date');
    expect(entries[0].pid).toBe(process.pid);
  });

  it('correlates a call with request, response, and duration lines', async () => {
    const file = join(dir, 'chat.log');
    let clock = 1_000;
    const logger = createOpenRouterLogger({ file, now: () => clock });

    const call = logger.start('chat', { model: 'test/model', zdr: true });
    clock = 1_750;
    call.succeed({ finishReason: 'stop' });

    const entries = await readEntries(file);
    expect(entries.map(entry => entry.event)).toEqual([
      'chat.request',
      'chat.response',
    ]);
    expect(entries[0].callId).toBe(call.callId);
    expect(entries[1].callId).toBe(call.callId);
    expect(entries[0].durationMs).toBeUndefined();
    expect(entries[1].durationMs).toBe(750);
    expect(entries[1]).toMatchObject({ level: 'info', finishReason: 'stop' });
  });

  it('records HTTP status and body on failures', async () => {
    const file = join(dir, 'errors.log');
    const logger = createOpenRouterLogger({ file });
    const call = logger.start('chat', { model: 'test/model' });
    const error = Object.assign(
      new Error('No endpoints found matching your filters'),
      { statusCode: 404, body: '{"error":{"message":"no zdr endpoint"}}' },
    );

    call.fail(error, { pluginId: 'base' });

    const entries = await readEntries(file);
    expect(entries.map(entry => entry.event)).toEqual([
      'chat.request',
      'chat.error',
    ]);
    const entry = entries[1];
    expect(entry?.event).toBe('chat.error');
    expect(entry?.level).toBe('error');
    expect(entry).toMatchObject({
      pluginId: 'base',
      error: {
        name: 'Error',
        message: 'No endpoints found matching your filters',
        statusCode: 404,
        responseBody: '{"error":{"message":"no zdr endpoint"}}',
      },
    });
  });

  it('writes nothing and returns null entries when disabled', () => {
    const append = vi.fn();
    const logger = createOpenRouterLogger({ file: false, append });

    expect(logger.enabled).toBe(false);
    expect(logger.file).toBeNull();
    expect(logger.log('plugin.init', { pluginId: 'base' })).toBeNull();
    expect(logger.start('chat', { model: 'test/model' }).succeed()).toBeNull();
    expect(append).not.toHaveBeenCalled();
  });

  it('swallows filesystem failures instead of breaking categorization', async () => {
    // A path whose parent is a regular file can never be created or appended.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');
    const logger = createOpenRouterLogger({
      file: join(blocker, 'nested.log'),
    });

    expect(() => logger.log('plugin.init', { pluginId: 'base' })).not.toThrow();
    expect(() => logger.start('chat').fail(new Error('boom'))).not.toThrow();
  });

  it('drops unwritable lines without throwing', async () => {
    const logger = createOpenRouterLogger({
      file: join(dir, 'circular.log'),
      append: () => {
        throw new Error('disk on fire');
      },
    });

    expect(() => logger.log('plugin.init')).not.toThrow();
    await expect(readFile(join(dir, 'circular.log'), 'utf8')).rejects.toThrow();
  });

  it('rotates the log once when it would exceed the size budget', async () => {
    const file = join(dir, 'rotating.log');
    const logger = createOpenRouterLogger({ file, maxBytes: 400 });
    logger.log('plugin.init', { pluginId: 'base', note: 'first generation' });
    logger.log('plugin.init', { pluginId: 'base', note: 'second generation' });
    await appendFile(file, `${'x'.repeat(300)}\n`, 'utf8');

    logger.log('plugin.init', { pluginId: 'base', note: 'third generation' });

    const current = await readEntries(file);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ note: 'third generation' });
    const rotated = await readFile(`${file}.1`, 'utf8');
    expect(rotated).toContain('first generation');
    expect(rotated).toContain('second generation');
  });

  it('creates missing parent directories for a custom path', async () => {
    const file = join(dir, 'deeply', 'nested', 'openrouter.log');
    createOpenRouterLogger({ file }).log('plugin.init');

    await expect(readFile(file, 'utf8')).resolves.toContain('plugin.init');
  });

  it('redacts credentials found in messages and bodies', () => {
    const lines: string[] = [];
    const logger = createOpenRouterLogger({
      file: join(dir, 'redacted.log'),
      append: (_file, line) => {
        lines.push(line);
      },
    });

    logger.start('chat').fail(
      Object.assign(new Error('request failed'), {
        body: '{"apiKey":"sk-or-v1-abcdefghijklmnop","authorization":"Bearer token-value"}',
      }),
    );
    logger.log('plugin.init', { apiKey: 'sk-or-v1-abcdefghijklmnop' });

    const output = lines.join('');
    expect(output).not.toContain('sk-or-v1-abcdefghijklmnop');
    expect(output).not.toContain('token-value');
    expect(output).toContain('[redacted-secret]');
    expect(JSON.parse(lines[2]).apiKey).toBe('[redacted-secret]');
  });

  it('bounds long strings, arrays, and nesting', () => {
    const lines: string[] = [];
    const logger = createOpenRouterLogger({
      file: join(dir, 'bounded.log'),
      append: (_file, line) => {
        lines.push(line);
      },
    });

    logger.log('plugin.init', {
      long: 'a'.repeat(3000),
      vector: Array.from({ length: 512 }, (_value, index) => index),
      deep: { level: { deeper: { deepest: 'value' } } },
      tooDeep: { a: { b: { c: { d: 'value' } } } },
      notFinite: Number.NaN,
      skipped: undefined,
    });

    const entry = JSON.parse(lines[0]) as OpenRouterLogEntry & {
      long: string;
      vector: { itemCount: number; items: number[] };
      deep: { level: { deeper: { deepest: string } } };
      tooDeep: { a: { b: { c: string } } };
      notFinite: null;
    };
    expect(entry.long.startsWith('a'.repeat(1024))).toBe(true);
    expect(entry.long).toContain('[truncated 1976 chars]');
    expect(entry.vector.itemCount).toBe(512);
    expect(entry.vector.items).toHaveLength(16);
    expect(entry.deep.level.deeper.deepest).toBe('value');
    expect(entry.tooDeep.a.b.c).toBe('[object]');
    expect(entry.notFinite).toBeNull();
    expect('skipped' in entry).toBe(false);
  });

  it('only previews payloads when content logging is on', () => {
    const off = createOpenRouterLogger({
      file: join(dir, 'off.log'),
      env: {},
    });
    expect(off.logContent).toBe(false);
    expect(off.preview('Coffee House - payee text')).toBeUndefined();

    const on = createOpenRouterLogger({
      file: join(dir, 'on.log'),
      env: { [OPENROUTER_LOG_CONTENT_ENV_VAR]: '1' },
    });
    expect(on.logContent).toBe(true);
    expect(on.preview('Coffee House - payee text')).toBe(
      'Coffee House - payee text',
    );
    expect(on.preview(['a', 'b'])).toContain('a');
    expect(on.preview('b'.repeat(900))).toContain('[truncated 400 chars]');
  });

  it('describes non-Error throws', () => {
    expect(describeError('plain string')).toEqual({
      name: 'UnknownError',
      message: 'plain string',
    });
    expect(describeError(null)).toEqual({
      name: 'UnknownError',
      message: 'null',
    });
    expect(
      describeError(
        Object.assign(new Error('outer'), {
          cause: Object.assign(new Error('inner'), { statusCode: 429 }),
        }),
      ),
    ).toEqual({
      name: 'Error',
      message: 'outer',
      cause: { name: 'Error', message: 'inner' },
    });
  });

  it('respects an environment-supplied content flag and pid', async () => {
    const logger = createOpenRouterLogger({
      env: {
        [OPENROUTER_LOG_FILE_ENV_VAR]: join(dir, 'from-env.log'),
        [OPENROUTER_LOG_CONTENT_ENV_VAR]: 'off',
      },
      pid: 4242,
    });

    expect(logger.file).toBe(join(dir, 'from-env.log'));
    expect(logger.logContent).toBe(false);
    logger.log('plugin.init');
    await expect(readFile(join(dir, 'from-env.log'), 'utf8')).resolves.toMatch(
      /"pid":4242/,
    );
  });

  it('creates the log file as owner-readable only', async () => {
    const file = join(dir, 'private.log');
    createOpenRouterLogger({ file }).log('plugin.init', { pluginId: 'base' });

    const info = await stat(file);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('leaves an existing directory untouched', async () => {
    await mkdir(join(dir, 'existing'), { recursive: true });
    const file = join(dir, 'existing', 'calls.log');
    createOpenRouterLogger({ file }).log('plugin.init');

    await expect(readFile(file, 'utf8')).resolves.toContain('plugin.init');
  });
});
