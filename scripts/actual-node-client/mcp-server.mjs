import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  ActualApiSession,
  normalizeResult,
  TOOL_DEFINITIONS,
} from './mcp-api.mjs';

const SERVER_NAME = 'actual-budget-api';
const SERVER_VERSION = '0.1.0';

export function redirectConsoleToStderr() {
  if (globalThis.__actualMcpConsoleRedirected) return;
  globalThis.__actualMcpConsoleRedirected = true;

  for (const method of ['log', 'info', 'debug', 'warn']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      console.error(`[${SERVER_NAME}]`, ...args);
    };
    console[method].__actualMcpOriginal = original;
  }
}

export function createActualMcpServer({
  session = new ActualApiSession(),
} = {}) {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions:
        'This server exposes the @actual-app/api Node client. Call actual_init or any API tool; authentication is read from GNOME Keyring and never supplied as a tool argument. Mutating tools operate on the currently loaded budget and should be used deliberately.',
    },
  );

  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: {
          readOnlyHint: definition.readOnly,
          destructiveHint: definition.destructive,
          idempotentHint: definition.readOnly,
        },
      },
      async args => {
        try {
          const result = await session.executeTool(definition.name, args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(normalizeResult(result), null, 2),
              },
            ],
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: message }, null, 2),
              },
            ],
          };
        }
      },
    );
  }

  return { server, session };
}

export async function runStdioServer() {
  redirectConsoleToStderr();
  const { server, session } = createActualMcpServer();
  const transport = new StdioServerTransport();
  let closing = false;

  const close = async () => {
    if (closing) return;
    closing = true;
    await session.shutdown().catch(error => {
      console.error(`[${SERVER_NAME}] shutdown failed`, error);
    });
    await server.close().catch(error => {
      console.error(`[${SERVER_NAME}] MCP close failed`, error);
    });
  };

  process.once('SIGINT', () => {
    void close().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void close().finally(() => process.exit(0));
  });
  transport.onclose = () => {
    void close();
  };

  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runStdioServer();
}
