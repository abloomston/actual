# Actual Budget MCP Server

> **TL;DR:** Actual is a local-first personal finance and budgeting app. The Actual MCP server exposes the `@actual-app/api` to MCP clients, letting an assistant inspect and make changes to a budget and synchronize it with an Actual server. Mutating tools affect the currently loaded budget, so verify the budget before changing anything.

## Basic lifecycle

This walkthrough uses no arguments for initialization. It assumes the budget is already available locally and the MCP setup has any required server connection details configured.

1. **Initialize the Actual API client.** The MCP integration uses `ACTUAL_PASSWORD` when set, or the server password stored in GNOME Keyring. Do not pass a password or session token to the tool.

   ```json
   actual-budget_actual_init({})
   ```

2. **List available budgets** and choose the local budget ID for the budget you intend to work with.

   ```json
   actual-budget_actual_get_budgets({})
   ```

3. **Load the budget** using its local ID.

   ```json
   actual-budget_actual_load_budget({ "id": "LOCAL_BUDGET_ID" })
   ```

4. **Sync before making changes** to bring the loaded budget up to date with the server.

   ```json
   actual-budget_actual_sync({})
   ```

5. **Make a change** using the relevant tool. For example, set a category's budget amount for a month:

   ```json
   actual-budget_actual_set_budget_amount({
     "month": "2026-06",
     "categoryId": "CATEGORY_ID",
     "value": 250
   })
   ```

   Replace the month, category ID, and amount with the intended values. Other changes use their corresponding tools, such as transaction, account, category, or schedule tools.

6. **Sync again** to synchronize the change with the server.

   ```json
   actual-budget_actual_sync({})
   ```

7. **Shut down the client** when finished.

   ```json
   actual-budget_actual_shutdown({})
   ```

## Important notes

- The arguments to `actual-budget_actual_init` are optional, but the tool metadata does not specify defaults for them. With an empty argument object, this workflow relies on the MCP setup for server connection details.
- If no budget appears in the list, it may need to be downloaded using its server Sync ID. This no-argument walkthrough does not download a budget.
- Syncing requires a loaded budget and a usable server connection. If the MCP setup has no server URL configured, provide the URL when initializing before expecting server sync to work.
- A **local budget ID** is used by `actual-budget_actual_load_budget`; a server **Sync ID** is used to download a budget. They are different identifiers.
- Be deliberate with mutating tools. Check the loaded budget and relevant IDs before making changes, then sync to publish the changes.
