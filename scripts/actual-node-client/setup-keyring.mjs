import {
  ENCRYPTION_PASSWORD_KIND,
  parseOptions,
  printUsage,
  SERVER_PASSWORD_KIND,
  storeKeyringSecret,
} from './common.mjs';

const options = parseOptions();

if (options.help) {
  printUsage(
    'scripts/actual-node-client/setup-keyring.mjs',
    `Use --secret-kind ${ENCRYPTION_PASSWORD_KIND} only for a budget's separate end-to-end encryption password.`,
  );
  process.exit(0);
}

if (
  options.secretKind !== SERVER_PASSWORD_KIND &&
  options.secretKind !== ENCRYPTION_PASSWORD_KIND
) {
  throw new Error(
    `Unsupported secret kind: ${options.secretKind}. Use ${SERVER_PASSWORD_KIND} or ${ENCRYPTION_PASSWORD_KIND}.`,
  );
}

const label =
  options.secretKind === SERVER_PASSWORD_KIND
    ? `Actual server password (${options.serverURL})`
    : `Actual encryption password (${options.serverURL})`;

console.log(`Storing ${options.secretKind} in the desktop keyring.`);
console.log(`Server: ${options.serverURL}`);
console.log(
  'The next prompt is handled by secret-tool; the secret is not echoed.',
);

await storeKeyringSecret({
  serverURL: options.serverURL,
  kind: options.secretKind,
  label,
});

console.log('Secret stored successfully.');
