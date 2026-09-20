import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_SERVER_URL = 'http://localhost:5006';
export const DEFAULT_DATA_DIR = join(
  homedir(),
  '.local',
  'share',
  'actual-node-client',
);
export const KEYRING_SERVICE = 'actual-node-client';
export const SERVER_PASSWORD_KIND = 'server-password';
export const ENCRYPTION_PASSWORD_KIND = 'encryption-password';

export function parseOptions(argv = process.argv.slice(2)) {
  const options = {
    serverURL: process.env.ACTUAL_SERVER_URL || DEFAULT_SERVER_URL,
    dataDir: process.env.ACTUAL_NODE_DATA_DIR || DEFAULT_DATA_DIR,
    syncId: process.env.ACTUAL_SYNC_ID || null,
    secretKind: SERVER_PASSWORD_KIND,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--server-url') {
      options.serverURL = requiredValue(argv, ++index, argument);
    } else if (argument.startsWith('--server-url=')) {
      options.serverURL = argument.slice('--server-url='.length);
    } else if (argument === '--data-dir') {
      options.dataDir = requiredValue(argv, ++index, argument);
    } else if (argument.startsWith('--data-dir=')) {
      options.dataDir = argument.slice('--data-dir='.length);
    } else if (argument === '--sync-id') {
      options.syncId = requiredValue(argv, ++index, argument);
    } else if (argument.startsWith('--sync-id=')) {
      options.syncId = argument.slice('--sync-id='.length);
    } else if (argument === '--secret-kind') {
      options.secretKind = requiredValue(argv, ++index, argument);
    } else if (argument.startsWith('--secret-kind=')) {
      options.secretKind = argument.slice('--secret-kind='.length);
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (!options.syncId) {
      options.syncId = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  return options;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

export async function ensureSecretTool() {
  try {
    await execFileAsync('secret-tool', ['--help']);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'secret-tool is not installed. Install it with: sudo apt-get install libsecret-tools',
      );
    }

    // secret-tool uses exit code 2 for --help even when it is installed.
    if (error?.code !== 2) {
      throw error;
    }
  }
}

export async function storeKeyringSecret({ serverURL, kind, label }) {
  await ensureSecretTool();

  await new Promise((resolve, reject) => {
    const child = spawn(
      'secret-tool',
      [
        'store',
        `--label=${label}`,
        'service',
        KEYRING_SERVICE,
        'server',
        serverURL,
        'kind',
        kind,
      ],
      { stdio: 'inherit' },
    );

    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`secret-tool store exited with code ${code}`));
      }
    });
  });
}

export async function readKeyringSecret({ serverURL, kind }) {
  await ensureSecretTool();

  try {
    const { stdout } = await execFileAsync('secret-tool', [
      'lookup',
      'service',
      KEYRING_SERVICE,
      'server',
      serverURL,
      'kind',
      kind,
    ]);

    return stdout.replace(/\r?\n$/, '');
  } catch (error) {
    if (error?.code === 1) {
      return null;
    }
    throw error;
  }
}

export async function ensureDataDir(dataDir) {
  await mkdir(dataDir, { recursive: true });
  if (process.platform !== 'win32') {
    await chmod(dataDir, 0o700);
  }
}

export function printUsage(scriptName, extra = '') {
  console.log(`Usage: node ${scriptName} [options]`);
  console.log('');
  console.log('Options:');
  console.log(`  --server-url <url>       Default: ${DEFAULT_SERVER_URL}`);
  console.log(`  --data-dir <path>        Default: ${DEFAULT_DATA_DIR}`);
  console.log('  --sync-id <id>           Required by the budget smoke test');
  console.log(`  --secret-kind <kind>     Default: ${SERVER_PASSWORD_KIND}`);
  if (extra) {
    console.log('');
    console.log(extra);
  }
}
