import { z } from 'zod';

import {
  DEFAULT_SERVER_URL,
  ENCRYPTION_PASSWORD_KIND,
  ensureDataDir,
  MCP_DEFAULT_DATA_DIR,
  readKeyringSecret,
} from './common.mjs';

const jsonObject = z.record(z.string(), z.unknown());
const emptySchema = z.object({});
const operationSchema = z.object({
  method: z.string().min(1),
  args: jsonObject.optional(),
});
const operationsSchema = z.array(operationSchema);
let actualApiPromise;

async function loadActualApi() {
  actualApiPromise ??= import('@actual-app/api').then(
    module => module.default || module,
  );
  return actualApiPromise;
}

function tool(name, description, inputSchema, invoke, options = {}) {
  return {
    name,
    description,
    inputSchema,
    invoke,
    apiMethod: options.apiMethod,
    requiresInit: options.requiresInit ?? true,
    readOnly: options.readOnly ?? false,
    destructive: options.destructive ?? false,
  };
}

const initSchema = z.object({
  serverURL: z.string().url().optional(),
  dataDir: z.string().min(1).optional(),
  syncId: z.string().min(1).optional(),
  downloadBudget: z.boolean().optional(),
});

const importBudgetSchema = z.object({
  source: z.string().min(1),
  sourceType: z.enum(['path', 'base64']).default('path'),
  type: z.enum(['actual', 'ynab4', 'ynab5']).default('actual'),
  filename: z.string().optional(),
});

const querySchema = z.object({
  query: jsonObject,
});

const budgetOperationSchema = z.object({
  operations: operationsSchema,
});

/**
 * Every public function exported by @actual-app/api is represented here. The
 * two callback-based API functions use operation lists because callbacks
 * cannot cross an MCP boundary. A few budget-file helpers are also included
 * for creating and cleaning up test files; those call the same internal
 * handlers used by the Actual client.
 */
export const TOOL_DEFINITIONS = [
  tool(
    'actual_init',
    'Initialize the Actual Node API client using the server password stored in the keyring. Never pass a password or session token to this tool.',
    initSchema,
    (_api, args, session) => session.initialize(args),
    { requiresInit: false },
  ),
  tool(
    'actual_shutdown',
    'Flush pending changes and close the Actual Node API client.',
    emptySchema,
    (_api, _args, session) => session.shutdown(),
    { requiresInit: false, destructive: false },
  ),
  tool(
    'actual_load_budget',
    'Load a budget from the Node client cache by its local budget id.',
    z.object({ id: z.string().min(1) }),
    (api, args, session) =>
      api.loadBudget(args.id).then(result => {
        session.markBudgetLoaded(args.id);
        session.configureCategorizationPlugin(args.id);
        return result;
      }),
    { apiMethod: 'loadBudget' },
  ),
  tool(
    'actual_download_budget',
    'Download a server budget by Sync ID into the isolated Node client cache. The optional encryption password is read from the keyring.',
    z.object({
      syncId: z.string().min(1),
      useEncryptionPassword: z.boolean().default(true),
    }),
    (_api, args, session) => session.downloadBudget(args),
    { apiMethod: 'downloadBudget', destructive: true },
  ),
  tool(
    'actual_get_budgets',
    'List local and server-backed budgets visible to the authenticated Actual account.',
    emptySchema,
    api => api.getBudgets(),
    { apiMethod: 'getBudgets', readOnly: true },
  ),
  tool(
    'actual_import_budget',
    'Import an Actual, YNAB4, or YNAB5 budget. Use sourceType=path for a path visible to the Node process, or sourceType=base64 for a base64-encoded file.',
    importBudgetSchema,
    async (api, args, session) => {
      const input =
        args.sourceType === 'base64'
          ? new Uint8Array(Buffer.from(args.source, 'base64'))
          : args.source;
      const result = await api.importBudget(input, {
        type: args.type,
        filename: args.filename,
      });
      session.markBudgetLoaded(result.id);
      session.configureCategorizationPlugin(result.id);
      return result;
    },
    { apiMethod: 'importBudget', destructive: true },
  ),
  tool(
    'actual_export_budget',
    'Export the currently loaded budget. The result contains a base64-encoded Actual zip.',
    emptySchema,
    api => api.exportBudget(),
    { apiMethod: 'exportBudget', readOnly: true },
  ),
  tool(
    'actual_sync',
    'Synchronize the currently loaded budget with the Actual server.',
    emptySchema,
    api => api.sync(),
    { apiMethod: 'sync', destructive: true },
  ),
  tool(
    'actual_run_bank_sync',
    'Run bank synchronization for one account, or all eligible accounts when accountId is omitted.',
    z.object({ accountId: z.string().optional() }),
    (api, args) => api.runBankSync(args),
    { apiMethod: 'runBankSync', destructive: true },
  ),
  tool(
    'actual_run_import',
    'Create an import budget, run a sequence of API operations inside the import callback, finish the import, and upload it. Operation names may be public API method names or actual_* tool names.',
    z.object({
      budgetName: z.string().min(1),
      operations: operationsSchema.default([]),
    }),
    (_api, args, session) => session.runImport(args),
    { apiMethod: 'runImport', destructive: true },
  ),
  tool(
    'actual_batch_budget_updates',
    'Run a sequence of budget API operations in one Actual batch update.',
    budgetOperationSchema,
    (_api, args, session) => session.batchBudgetUpdates(args),
    { apiMethod: 'batchBudgetUpdates', destructive: true },
  ),
  tool(
    'actual_run_query',
    'Run an AQL query using a serialized Query state object.',
    querySchema,
    (api, args) => api.runQuery({ serialize: () => args.query }),
    { apiMethod: 'runQuery', readOnly: true },
  ),
  tool(
    'actual_aql_query',
    'Run an AQL query using a serialized Query state object.',
    querySchema,
    (api, args) => api.aqlQuery({ serialize: () => args.query }),
    { apiMethod: 'aqlQuery', readOnly: true },
  ),
  tool(
    'actual_q',
    'Create the serialized starting state for an Actual AQL query. Pass the returned state to actual_aql_query or actual_run_query after adding expressions.',
    z.object({ table: z.string().min(1) }),
    (api, args) => api.q(args.table).serialize(),
    { apiMethod: 'q', readOnly: true },
  ),
  tool(
    'actual_get_budget_months',
    'List all budget months in the currently loaded budget.',
    emptySchema,
    api => api.getBudgetMonths(),
    { apiMethod: 'getBudgetMonths', readOnly: true },
  ),
  tool(
    'actual_get_budget_month',
    'Read the budget and category state for one YYYY-MM month.',
    z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }),
    (api, args) => api.getBudgetMonth(args.month),
    { apiMethod: 'getBudgetMonth', readOnly: true },
  ),
  tool(
    'actual_set_budget_amount',
    'Set a category budget amount for a month.',
    z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      categoryId: z.string().min(1),
      value: z.number(),
    }),
    (api, args) => api.setBudgetAmount(args.month, args.categoryId, args.value),
    { apiMethod: 'setBudgetAmount', destructive: true },
  ),
  tool(
    'actual_set_budget_carryover',
    'Enable or disable category budget carryover for a month.',
    z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      categoryId: z.string().min(1),
      flag: z.boolean(),
    }),
    (api, args) =>
      api.setBudgetCarryover(args.month, args.categoryId, args.flag),
    { apiMethod: 'setBudgetCarryover', destructive: true },
  ),
  tool(
    'actual_add_transactions',
    'Add transactions to an account.',
    z.object({
      accountId: z.string().min(1),
      transactions: z.array(jsonObject),
      learnCategories: z.boolean().optional(),
      runTransfers: z.boolean().optional(),
    }),
    (api, args) =>
      api.addTransactions(args.accountId, args.transactions, {
        learnCategories: args.learnCategories,
        runTransfers: args.runTransfers,
      }),
    { apiMethod: 'addTransactions', destructive: true },
  ),
  tool(
    'actual_import_transactions',
    'Import and reconcile transactions for an account.',
    z.object({
      accountId: z.string().min(1),
      transactions: z.array(jsonObject),
      opts: jsonObject.optional(),
    }),
    (api, args) =>
      api.importTransactions(args.accountId, args.transactions, args.opts),
    { apiMethod: 'importTransactions', destructive: true },
  ),
  tool(
    'actual_get_transactions',
    'Read transactions for an account between two inclusive date strings.',
    z.object({
      accountId: z.string().min(1),
      startDate: z.string().min(1),
      endDate: z.string().min(1),
    }),
    (api, args) =>
      api.getTransactions(args.accountId, args.startDate, args.endDate),
    { apiMethod: 'getTransactions', readOnly: true },
  ),
  tool(
    'actual_update_transaction',
    'Update selected fields on a transaction.',
    z.object({ id: z.string().min(1), fields: jsonObject }),
    (api, args) => api.updateTransaction(args.id, args.fields),
    { apiMethod: 'updateTransaction', destructive: true },
  ),
  tool(
    'actual_delete_transaction',
    'Delete a transaction.',
    z.object({ id: z.string().min(1) }),
    (api, args) => api.deleteTransaction(args.id),
    { apiMethod: 'deleteTransaction', destructive: true },
  ),
  tool(
    'actual_merge_transactions',
    'Merge exactly two transactions and return the retained transaction id.',
    z.object({ ids: z.tuple([z.string().min(1), z.string().min(1)]) }),
    (api, args) => api.mergeTransactions(args.ids),
    { apiMethod: 'mergeTransactions', destructive: true },
  ),
  tool(
    'actual_get_accounts',
    'List accounts in the current budget.',
    emptySchema,
    api => api.getAccounts(),
    { apiMethod: 'getAccounts', readOnly: true },
  ),
  tool(
    'actual_create_account',
    'Create an account, optionally with an initial balance.',
    z.object({ account: jsonObject, initialBalance: z.number().optional() }),
    (api, args) => api.createAccount(args.account, args.initialBalance),
    { apiMethod: 'createAccount', destructive: true },
  ),
  tool(
    'actual_update_account',
    'Update an account.',
    z.object({ id: z.string().min(1), fields: jsonObject }),
    (api, args) => api.updateAccount(args.id, args.fields),
    { apiMethod: 'updateAccount', destructive: true },
  ),
  tool(
    'actual_close_account',
    'Close an account, optionally transferring its balance to another account or category.',
    z.object({
      id: z.string().min(1),
      transferAccountId: z.string().optional(),
      transferCategoryId: z.string().optional(),
    }),
    (api, args) =>
      api.closeAccount(
        args.id,
        args.transferAccountId,
        args.transferCategoryId,
      ),
    { apiMethod: 'closeAccount', destructive: true },
  ),
  tool(
    'actual_reopen_account',
    'Reopen a closed account.',
    z.object({ id: z.string().min(1) }),
    (api, args) => api.reopenAccount(args.id),
    { apiMethod: 'reopenAccount', destructive: true },
  ),
  tool(
    'actual_delete_account',
    'Delete an account.',
    z.object({ id: z.string().min(1) }),
    (api, args) => api.deleteAccount(args.id),
    { apiMethod: 'deleteAccount', destructive: true },
  ),
  tool(
    'actual_get_account_balance',
    'Read an account balance, optionally as of an ISO date.',
    z.object({ id: z.string().min(1), cutoff: z.string().optional() }),
    (api, args) =>
      api.getAccountBalance(
        args.id,
        args.cutoff ? new Date(args.cutoff) : undefined,
      ),
    { apiMethod: 'getAccountBalance', readOnly: true },
  ),
  tool(
    'actual_get_account_groups',
    'List account groups.',
    emptySchema,
    api => api.getAccountGroups(),
    { apiMethod: 'getAccountGroups', readOnly: true },
  ),
  tool(
    'actual_create_account_group',
    'Create an account group.',
    z.object({ group: jsonObject }),
    (api, args) => api.createAccountGroup(args.group),
    { apiMethod: 'createAccountGroup', destructive: true },
  ),
  tool(
    'actual_update_account_group',
    'Update an account group.',
    z.object({ id: z.string().min(1), fields: jsonObject }),
    (api, args) => api.updateAccountGroup(args.id, args.fields),
    { apiMethod: 'updateAccountGroup', destructive: true },
  ),
  tool(
    'actual_delete_account_group',
    'Delete an account group.',
    z.object({ id: z.string().min(1) }),
    (api, args) => api.deleteAccountGroup(args.id),
    { apiMethod: 'deleteAccountGroup', destructive: true },
  ),
  tool(
    'actual_get_category_groups',
    'List category groups, optionally including hidden groups.',
    z.object({ hidden: z.boolean().optional() }),
    (api, args) => api.getCategoryGroups(args),
    { apiMethod: 'getCategoryGroups', readOnly: true },
  ),
  tool(
    'actual_create_category_group',
    'Create a category group.',
    z.object({ group: jsonObject }),
    (api, args) => api.createCategoryGroup(args.group),
    { apiMethod: 'createCategoryGroup', destructive: true },
  ),
  tool(
    'actual_update_category_group',
    'Update a category group.',
    z.object({ id: z.string().min(1), fields: jsonObject }),
    (api, args) => api.updateCategoryGroup(args.id, args.fields),
    { apiMethod: 'updateCategoryGroup', destructive: true },
  ),
  tool(
    'actual_delete_category_group',
    'Delete a category group, optionally transferring categories to another group.',
    z.object({
      id: z.string().min(1),
      transferCategoryId: z.string().optional(),
    }),
    (api, args) => api.deleteCategoryGroup(args.id, args.transferCategoryId),
    { apiMethod: 'deleteCategoryGroup', destructive: true },
  ),
  tool(
    'actual_get_categories',
    'List categories, optionally including hidden categories.',
    z.object({ hidden: z.boolean().optional() }),
    (api, args) => api.getCategories(args),
    { apiMethod: 'getCategories', readOnly: true },
  ),
  tool(
    'actual_create_category',
    'Create a category in a category group.',
    z.object({ category: jsonObject }),
    (api, args) => api.createCategory(args.category),
    { apiMethod: 'createCategory', destructive: true },
  ),
  tool(
    'actual_update_category',
    'Update a category.',
    z.object({ id: z.string().min(1), fields: jsonObject }),
    (api, args) => api.updateCategory(args.id, args.fields),
    { apiMethod: 'updateCategory', destructive: true },
  ),
  tool(
    'actual_delete_category',
    'Delete a category, optionally transferring transactions to another category.',
    z.object({
      id: z.string().min(1),
      transferCategoryId: z.string().optional(),
    }),
    (api, args) => api.deleteCategory(args.id, args.transferCategoryId),
    { apiMethod: 'deleteCategory', destructive: true },
  ),
  tool(
    'actual_get_note',
    'Read the note associated with an entity id.',
    z.object({ id: z.string().min(1) }),
    (api, args) => api.getNote(args.id),
    { apiMethod: 'getNote', readOnly: true },
  ),
  tool(
    'actual_update_note',
    'Set the note associated with an entity id.',
    z.object({ id: z.string().min(1), note: z.string() }),
    (api, args) => api.updateNote(args.id, args.note),
    { apiMethod: 'updateNote', destructive: true },
  ),
  tool(
    'actual_get_common_payees',
    'List common payees.',
    emptySchema,
    api => api.getCommonPayees(),
    { apiMethod: 'getCommonPayees', readOnly: true },
  ),
  tool(
    'actual_get_payees',
    'List payees.',
    emptySchema,
    api => api.getPayees(),
    { apiMethod: 'getPayees', readOnly: true },
  ),
  tool(
    'actual_create_payee',
    'Create a payee.',
    z.object({ payee: jsonObject }),
    (api, args) => api.createPayee(args.payee),
    { apiMethod: 'createPayee', destructive: true },
  ),
  tool(
    'actual_update_payee',
    'Update a payee.',
    z.object({ id: z.string().min(1), fields: jsonObject }),
    (api, args) => api.updatePayee(args.id, args.fields),
    { apiMethod: 'updatePayee', destructive: true },
  ),
  tool(
    'actual_delete_payee',
    'Delete a payee.',
    z.object({ id: z.string().min(1) }),
    (api, args) => api.deletePayee(args.id),
    { apiMethod: 'deletePayee', destructive: true },
  ),
  tool('actual_get_tags', 'List tags.', emptySchema, api => api.getTags(), {
    apiMethod: 'getTags',
    readOnly: true,
  }),
  tool(
    'actual_create_tag',
    'Create a tag.',
    z.object({ tag: jsonObject }),
    (api, args) => api.createTag(args.tag),
    { apiMethod: 'createTag', destructive: true },
  ),
  tool(
    'actual_update_tag',
    'Update a tag.',
    z.object({ id: z.string().min(1), fields: jsonObject }),
    (api, args) => api.updateTag(args.id, args.fields),
    { apiMethod: 'updateTag', destructive: true },
  ),
  tool(
    'actual_delete_tag',
    'Delete a tag.',
    z.object({ id: z.string().min(1) }),
    (api, args) => api.deleteTag(args.id),
    { apiMethod: 'deleteTag', destructive: true },
  ),
  tool(
    'actual_merge_payees',
    'Merge payees into a target payee.',
    z.object({
      targetId: z.string().min(1),
      mergeIds: z.array(z.string().min(1)),
    }),
    (api, args) => api.mergePayees(args.targetId, args.mergeIds),
    { apiMethod: 'mergePayees', destructive: true },
  ),
  tool(
    'actual_get_rules',
    'List transaction rules.',
    emptySchema,
    api => api.getRules(),
    { apiMethod: 'getRules', readOnly: true },
  ),
  tool(
    'actual_get_payee_rules',
    'List rules associated with a payee.',
    z.object({ id: z.string().min(1) }),
    (api, args) => api.getPayeeRules(args.id),
    { apiMethod: 'getPayeeRules', readOnly: true },
  ),
  tool(
    'actual_create_rule',
    'Create a transaction rule.',
    z.object({ rule: jsonObject }),
    (api, args) => api.createRule(args.rule),
    { apiMethod: 'createRule', destructive: true },
  ),
  tool(
    'actual_update_rule',
    'Update a transaction rule.',
    z.object({ rule: jsonObject }),
    (api, args) => api.updateRule(args.rule),
    { apiMethod: 'updateRule', destructive: true },
  ),
  tool(
    'actual_delete_rule',
    'Delete a transaction rule.',
    z.object({ id: z.string().min(1) }),
    (api, args) => api.deleteRule(args.id),
    { apiMethod: 'deleteRule', destructive: true },
  ),
  tool(
    'actual_hold_budget_for_next_month',
    'Hold an amount for the next budget month.',
    z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), amount: z.number() }),
    (api, args) => api.holdBudgetForNextMonth(args.month, args.amount),
    { apiMethod: 'holdBudgetForNextMonth', destructive: true },
  ),
  tool(
    'actual_reset_budget_hold',
    'Reset a budget hold for a month.',
    z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }),
    (api, args) => api.resetBudgetHold(args.month),
    { apiMethod: 'resetBudgetHold', destructive: true },
  ),
  tool(
    'actual_create_schedule',
    'Create a scheduled transaction.',
    z.object({ schedule: jsonObject }),
    (api, args) => api.createSchedule(args.schedule),
    { apiMethod: 'createSchedule', destructive: true },
  ),
  tool(
    'actual_update_schedule',
    'Update a scheduled transaction.',
    z.object({
      id: z.string().min(1),
      fields: jsonObject,
      resetNextDate: z.boolean().optional(),
    }),
    (api, args) => api.updateSchedule(args.id, args.fields, args.resetNextDate),
    { apiMethod: 'updateSchedule', destructive: true },
  ),
  tool(
    'actual_delete_schedule',
    'Delete a scheduled transaction.',
    z.object({ scheduleId: z.string().min(1) }),
    (api, args) => api.deleteSchedule(args.scheduleId),
    { apiMethod: 'deleteSchedule', destructive: true },
  ),
  tool(
    'actual_get_schedules',
    'List scheduled transactions.',
    emptySchema,
    api => api.getSchedules(),
    { apiMethod: 'getSchedules', readOnly: true },
  ),
  tool(
    'actual_get_id_by_name',
    'Resolve an account, schedule, category, or payee name to its id.',
    z.object({
      type: z.enum(['accounts', 'schedules', 'categories', 'payees']),
      name: z.string().min(1),
    }),
    (api, args) => api.getIDByName(args.type, args.name),
    { apiMethod: 'getIDByName', readOnly: true },
  ),
  tool(
    'actual_get_server_version',
    'Read the Actual server version.',
    emptySchema,
    api => api.getServerVersion(),
    { apiMethod: 'getServerVersion', readOnly: true },
  ),
  tool(
    'actual_get_preferences',
    'Read synced budget preferences.',
    emptySchema,
    api => api.getPreferences(),
    { apiMethod: 'getPreferences', readOnly: true },
  ),
  tool(
    'actual_set_preference',
    'Set a synced budget preference. Omit value to save undefined.',
    z.object({ id: z.string().min(1), value: z.unknown().optional() }),
    (api, args) => api.setPreference(args.id, args.value),
    { apiMethod: 'setPreference', destructive: true },
  ),
  tool(
    'actual_amount_to_integer',
    'Convert a decimal amount to Actual integer units.',
    z.object({ amount: z.number(), fraction: z.number().optional() }),
    (api, args) => api.utils.amountToInteger(args.amount, args.fraction),
    { apiMethod: 'utils.amountToInteger', readOnly: true },
  ),
  tool(
    'actual_integer_to_amount',
    'Convert Actual integer units to a decimal amount.',
    z.object({ amount: z.number(), fraction: z.number().optional() }),
    (api, args) => api.utils.integerToAmount(args.amount, args.fraction),
    { apiMethod: 'utils.integerToAmount', readOnly: true },
  ),
  tool(
    'actual_create_budget_file',
    "Integration helper: create and upload a new budget file with a unique name. This is not part of the public @actual-app/api export, but uses Actual's own create-budget handler.",
    z.object({ budgetName: z.string().min(1) }),
    async (api, args, session) => {
      if (!api.internal) {
        throw new Error('Actual API internals are not initialized');
      }
      await api.internal.send('close-budget');
      const result = await api.internal.send('create-budget', {
        budgetName: args.budgetName,
      });
      if (result?.error) {
        throw new Error(
          `Could not create budget file: ${JSON.stringify(result.error)}`,
        );
      }
      session.markBudgetLoaded(args.budgetName);
      return result;
    },
    { requiresInit: true, destructive: true },
  ),
  tool(
    'actual_delete_budget_file',
    'Integration helper: close and remove a local/cloud budget file by local id, cloudFileId, or both. Use only for files you created intentionally.',
    z.object({
      id: z.string().optional(),
      cloudFileId: z.string().optional(),
    }),
    async (api, args, session) => {
      if (!args.id && !args.cloudFileId) {
        throw new Error(
          'Provide id or cloudFileId when deleting a budget file',
        );
      }
      if (!api.internal) {
        throw new Error('Actual API internals are not initialized');
      }
      await api.internal.send('close-budget');
      let result = 'ok';
      if (args.cloudFileId) {
        result = await api.internal.send('delete-budget', {
          cloudFileId: args.cloudFileId,
        });
      }
      if (args.id) {
        result = await api.internal.send('delete-budget', { id: args.id });
      }
      session.markBudgetClosed();
      return result;
    },
    { requiresInit: true, destructive: true },
  ),
];

export const TOOL_DEFINITION_MAP = new Map(
  TOOL_DEFINITIONS.map(definition => [definition.name, definition]),
);

export const API_METHOD_TO_TOOL = new Map(
  TOOL_DEFINITIONS.filter(definition => definition.apiMethod).map(
    definition => [definition.apiMethod, definition.name],
  ),
);

export function normalizeResult(value, seen = new WeakSet()) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return {
      encoding: 'base64',
      byteLength: value.byteLength,
      data: Buffer.from(value).toString('base64'),
    };
  }
  if (value instanceof ArrayBuffer) {
    return normalizeResult(new Uint8Array(value), seen);
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map(item => normalizeResult(item, seen));
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = normalizeResult(item, seen);
  }
  return result;
}

class OperationQueue {
  tail = Promise.resolve();

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class ActualApiSession {
  constructor({
    api = null,
    readSecret = readKeyringSecret,
    ensureDir = ensureDataDir,
    serverURL = process.env.ACTUAL_SERVER_URL || DEFAULT_SERVER_URL,
    dataDir = process.env.ACTUAL_MCP_DATA_DIR ||
      process.env.ACTUAL_NODE_DATA_DIR ||
      MCP_DEFAULT_DATA_DIR,
  } = {}) {
    this.api = api;
    this.readSecret = readSecret;
    this.ensureDir = ensureDir;
    this.defaultServerURL = serverURL;
    this.defaultDataDir = dataDir;
    this.initialized = false;
    this.loadedBudgetId = null;
    this.config = null;
    this.queue = new OperationQueue();
  }

  async executeTool(name, args = {}) {
    const definition = TOOL_DEFINITION_MAP.get(name);
    if (!definition) throw new Error(`Unknown Actual MCP tool: ${name}`);

    return this.queue.run(async () => {
      if (definition.requiresInit) await this.ensureInitialized();
      const api = await this.getApi();
      return definition.invoke(api, args, this);
    });
  }

  async invokeOperation(operation) {
    const requestedName = operation.method.startsWith('actual_')
      ? operation.method
      : API_METHOD_TO_TOOL.get(operation.method);
    if (!requestedName) {
      throw new Error(
        `Unknown API operation in callback sequence: ${operation.method}`,
      );
    }
    const definition = TOOL_DEFINITION_MAP.get(requestedName);
    if (
      !definition ||
      definition.name === 'actual_init' ||
      definition.name === 'actual_shutdown'
    ) {
      throw new Error(
        `Operation ${operation.method} cannot run inside a callback sequence`,
      );
    }
    if (
      definition.name === 'actual_run_import' ||
      definition.name === 'actual_batch_budget_updates'
    ) {
      throw new Error(
        `Nested callback operation ${operation.method} is not supported`,
      );
    }
    return definition.invoke(this.api, operation.args || {}, this);
  }

  async getApi() {
    if (!this.api) this.api = await loadActualApi();
    return this.api;
  }

  async initialize(args = {}) {
    const serverURL = args.serverURL || this.defaultServerURL;
    const dataDir = args.dataDir || this.defaultDataDir;
    const syncId = args.syncId || process.env.ACTUAL_SYNC_ID;

    if (this.initialized) {
      if (
        this.config.serverURL === serverURL &&
        this.config.dataDir === dataDir &&
        !syncId
      ) {
        return this.status();
      }
      await this.shutdown();
    }

    const password = await this.readSecret({
      serverURL,
      kind: 'server-password',
    });
    if (!password) {
      throw new Error(
        'No server password was found in the keyring. Run setup-keyring.mjs first.',
      );
    }

    await this.ensureDir(dataDir);
    const api = await this.getApi();
    await api.init({ dataDir, serverURL, password });
    api.enableDefaultCategorizationPlugin?.();
    this.initialized = true;
    this.config = { serverURL, dataDir };

    if (syncId && args.downloadBudget !== false) {
      await this.downloadBudget({
        syncId,
        useEncryptionPassword: true,
      });
    }

    return this.status({ syncId: syncId || undefined });
  }

  async ensureInitialized() {
    if (!this.initialized) await this.initialize();
  }

  async downloadBudget({ syncId, useEncryptionPassword = true }) {
    await this.ensureInitialized();
    let encryptionPassword = null;
    if (useEncryptionPassword) {
      encryptionPassword = await this.readSecret({
        serverURL: this.config.serverURL,
        kind: ENCRYPTION_PASSWORD_KIND,
      });
    }
    const api = await this.getApi();
    const result = await api.downloadBudget(
      syncId,
      encryptionPassword ? { password: encryptionPassword } : undefined,
    );
    this.markBudgetLoaded(result?.id || syncId);
    this.configureCategorizationPlugin(result?.id || syncId);
    return result;
  }

  async runImport({ budgetName, operations = [] }) {
    await this.ensureInitialized();
    const api = await this.getApi();
    await api.runImport(budgetName, async () => {
      for (const operation of operations) {
        await this.invokeOperation(operation);
      }
    });
    this.markBudgetLoaded(budgetName);
  }

  async batchBudgetUpdates({ operations }) {
    await this.ensureInitialized();
    const api = await this.getApi();
    return api.batchBudgetUpdates(async () => {
      const results = [];
      for (const operation of operations) {
        results.push(await this.invokeOperation(operation));
      }
      return results;
    });
  }

  async shutdown() {
    if (!this.initialized) return null;
    try {
      const api = await this.getApi();
      return await api.shutdown();
    } finally {
      this.initialized = false;
      this.loadedBudgetId = null;
      this.config = null;
    }
  }

  markBudgetLoaded(id) {
    this.loadedBudgetId = id;
  }

  configureCategorizationPlugin(budgetId = this.loadedBudgetId) {
    if (!budgetId || !this.api) return;
    this.api.configureDefaultCategorizationPlugin?.(budgetId);
  }

  markBudgetClosed() {
    this.loadedBudgetId = null;
  }

  status(extra = {}) {
    return {
      initialized: this.initialized,
      serverURL: this.config?.serverURL || this.defaultServerURL,
      dataDir: this.config?.dataDir || this.defaultDataDir,
      loadedBudgetId: this.loadedBudgetId,
      ...extra,
    };
  }
}

export function getToolDefinitions() {
  return TOOL_DEFINITIONS.map(
    ({ name, description, inputSchema, readOnly, destructive }) => ({
      name,
      description,
      inputSchema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: destructive,
        idempotentHint: readOnly,
      },
    }),
  );
}
