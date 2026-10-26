# OpenRouter Zero Data Retention Models

This document records OpenRouter models that are suitable for the
categorization plugins when requests must use Zero Data Retention (ZDR)
endpoints.

OpenRouter availability is provider-specific and changes over time. A model is
listed here when the live ZDR endpoint catalog reports at least one provider
endpoint for it. The live catalog is authoritative:

<https://openrouter.ai/api/v1/endpoints/zdr>

The tables below were regenerated from that catalog on **2026-10-25**, together
with the model metadata from <https://openrouter.ai/api/v1/models>. Treat them
as a snapshot: a listed model can lose its ZDR endpoints, and a request pinned
to ZDR then fails instead of rerouting. Re-check the live catalog before
changing a default.

## ZDR Routing

ZDR is an endpoint policy, not a property shared by every provider for a model.
For example, OpenAI embedding models currently have ZDR endpoints through
Azure, while the first-party OpenAI endpoints are not necessarily ZDR.

OpenRouter supports per-request ZDR enforcement with the following provider
preference:

```json
{
  "provider": {
    "zdr": true
  }
}
```

The categorization plugin's built-in OpenRouter chat and embedding transports
always include this preference. If no ZDR endpoint is available for the
requested model, the request should fail rather than silently route to a
non-ZDR endpoint.

Custom `transport` or `embeddingTransport` implementations that bypass the
built-in SDK transports are responsible for honoring the preference themselves.

## API Key

The Node API/MCP default plugin bootstrap reads the OpenRouter key from:

```bash
export ACTUAL__OPENROUTER_API_KEY="..."
```

The name intentionally has two underscores after `ACTUAL` and no underscore
between `OPEN` and `ROUTER`.

## Call Log

Every request the built-in SDK transports make is appended to a named log file
so a judge call that returns nothing, or never happens, can be explained after
the fact. This covers the traffic the MCP server generates through the Node API.

```bash
tail -f /tmp/actual-openrouter.log
```

One JSON object per line (`JSONL`). Relevant fields:

| Event                                 | Written when                                         | Notable fields                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plugin.init`                         | the OpenRouter plugin is built                       | `hasApiKey`, `apiKeySource`, `chatTransport`/`embeddingTransport` (`openrouter-sdk` vs `custom`), `logFile`, `logContent`                              |
| `plugin.skipped`                      | the Node API default plugin is not registered        | `reason` (missing `ACTUAL__OPENROUTER_API_KEY`)                                                                                                        |
| `chat.request`, `embedding.request`   | a call leaves the plugin                             | `model`, `zdr`, `maxTokens`, `responseFormatType`, `promptCacheKey`, `messageCount`, `promptChars`                                                     |
| `chat.response`, `embedding.response` | the call returns                                     | `finishReason`, `contentChars`, `reasoningChars`, `usage` (prompt/completion/reasoning/cached tokens, cost), `routing` (provider, attempts, endpoints) |
| `chat.error`, `embedding.error`       | the call throws                                      | `error.name`, `error.message`, `error.statusCode`, `error.responseBody`                                                                                |
| `judge.error`                         | the request succeeded but produced no usable verdict | `contentChars`, `error.message` (no message content, invalid JSON, unknown category ID)                                                                |

A `chat.request` and the line that settles it share a `callId`; `durationMs` is
measured between them.

Two environment variables control the log:

```bash
# Where to write. `off` (or an empty value) disables file logging entirely.
export ACTUAL__OPENROUTER_LOG_FILE=/tmp/actual-openrouter.log
# Opt in to request/response payload previews. Off by default: prompts contain
# payees, notes and raw synced data, and /tmp is readable by local processes.
export ACTUAL__OPENROUTER_LOG_CONTENT=1
```

The log rotates once to `<file>.1` when a line would push it past 2 MiB, API-key
shaped strings are redacted even inside error bodies, the file is created
owner-read/write only (`0600`), and logging failures never interrupt
categorization. `createOpenRouterPlugin` also accepts `logFile` (a path, or
`false`) and `logContent` for hosts that configure it in code.

Reading the common failures:

- No `plugin.init` line at all, or a `plugin.skipped` line: the plugin was never
  registered because `ACTUAL__OPENROUTER_API_KEY` is not set in the process that
  runs the MCP server.
- `chat.error` with `statusCode: 404` and a body about endpoints: the model has
  no Zero Data Retention endpoint, so the ZDR pin rejected the request.
- `chat.response` with `finishReason: "length"`, `contentChars: 0` and a
  `usage.reasoningTokens` close to `maxTokens`: thinking consumed the completion
  budget; raise `maxTokens`.
- `judge.error` after a successful `chat.response`: the model answered, but not
  with a usable verdict.

## Embedding Models

These embedding model IDs currently have at least one ZDR endpoint:

| Model ID                        | ZDR provider endpoints         | Context length | Notes                                                                               |
| ------------------------------- | ------------------------------ | -------------: | ----------------------------------------------------------------------------------- |
| `openai/text-embedding-3-small` | Azure                          |          8,192 | Recommended general-purpose baseline; the project default.                          |
| `openai/text-embedding-3-large` | Azure                          |          8,192 | Higher-quality OpenAI option with larger vectors and higher cost.                   |
| `qwen/qwen3-embedding-4b`       | DeepInfra                      |         32,768 | Larger multilingual embedding option.                                               |
| `qwen/qwen3-embedding-8b`       | DeepInfra, Nebius, SiliconFlow |  32,768–40,960 | Highest-capacity Qwen embedding option in the current ZDR catalog.                  |
| `baai/bge-m3`                   | DeepInfra, Parasail            |    8,192–8,194 | Multilingual retrieval model.                                                       |
| `baai/bge-base-en-v1.5`         | DeepInfra                      |            512 | Small English-only model.                                                           |
| `baai/bge-large-en-v1.5`        | DeepInfra                      |            512 | Larger English-only BGE model.                                                      |
| `google/gemini-embedding-001`   | Google Vertex                  |         20,000 | Google embedding model available through Vertex.                                    |
| `google/gemini-embedding-2`     | Google Vertex                  |          8,192 | Newer Google embedding model; the endpoint also advertises image and audio pricing. |

The following previously considered models were not present in the live ZDR
embedding endpoint catalog when this document was written:

- `qwen/qwen3-embedding-0.6b`
- `voyage/voyage-code-4`

Changing the embedding model changes the vector space. Re-index all historical
transactions and use a new index path, or allow the plugin's model/version
metadata filters to isolate the new vectors from older ones. Changing only the
judge model does not require re-embedding: the vector index is keyed by
embedding model and `EMBEDDING_VERSION`, and the default embedding model stays
`openai/text-embedding-3-small`.

To select a model:

```ts
const embeddings = createEmbeddingPlugin({
  base: openRouter,
  budgetKey: 'your-budget-id',
  indexPath: '/path/to/index',
  embeddingModel: 'openai/text-embedding-3-small',
});
```

The current plugin uses each model's default output dimensions. OpenRouter
supports a `dimensions` request parameter for some models, but the plugin does
not expose that option yet.

## LLM-as-Judge Models

The judge sends a JSON Schema response-format request. The options below have
both a ZDR endpoint and `response_format` or structured-output support reported
for at least one current ZDR endpoint.

| Model ID                            | ZDR provider endpoints                                                                      | Context length | Best fit                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | -------------: | ------------------------------------------------------------ |
| `openai/gpt-5.6-luna`               | Azure                                                                                       |      1,050,000 | Higher-capacity OpenAI judge.                                |
| `openai/gpt-5.4-mini`               | Azure                                                                                       |        400,000 | Lower-cost OpenAI judge.                                     |
| `openai/gpt-5.4-nano`               | Azure                                                                                       |        400,000 | Lowest-cost/latency OpenAI option for simple categorization. |
| `openai/gpt-4.1-mini`               | Azure                                                                                       |      1,047,576 | Mature, economical structured-output option.                 |
| `google/gemini-3.5-flash-lite`      | Google Vertex (global, us, eu, flex, priority)                                              |      1,048,576 | Current project default; cost- and latency-oriented judge.   |
| `google/gemini-3.5-flash`           | Google Vertex (global, us, flex, priority)                                                  |      1,048,576 | Higher-quality Google judge; advertises `temperature`.       |
| `anthropic/claude-haiku-4.5`        | Amazon Bedrock, Google Vertex                                                               |        200,000 | Fast Anthropic option.                                       |
| `anthropic/claude-sonnet-4.6`       | Amazon Bedrock, Google Vertex                                                               |      1,000,000 | Higher-quality Anthropic option.                             |
| `deepseek/deepseek-v3.2`            | DeepInfra, DigitalOcean, Google Vertex, Mara, Phala, SambaNova, SiliconFlow, Venice         | 32,768–163,840 | Cost-effective open-model judge with broad routing.          |
| `qwen/qwen3-32b`                    | DeepInfra, SiliconFlow, Tenstorrent                                                         | 20,000–131,072 | Open-weight judge option.                                    |
| `meta-llama/llama-3.3-70b-instruct` | AkashML, Cloudflare, CoreWeave, DeepInfra, Google Vertex, Groq, Novita, Parasail, SambaNova | 12,288–131,072 | Open-weight judge with broad provider availability.          |

The Gemini 2.5 Flash rows that used to be in this table
(`google/gemini-2.5-flash`, `google/gemini-2.5-flash-lite` and
`google/gemini-2.5-pro`) were removed: none of them has a ZDR endpoint in the
2026-10-25 catalog. The only Gemini 2.5 entries left there are
`gemini-2.5-flash-image` and `gemini-2.5-pro-preview`, so the 2.5 text models
are still routable in general but unreachable for a ZDR-pinned judge.

### Gemini 3.x thinking, `temperature`, and the completion budget

Gemini 3.x models always think, and the parameters their ZDR endpoints
advertise differ from what the models API advertises for the model as a whole:

| Model ID                       | ZDR endpoints (`max_completion_tokens`)                                           | Structured output                                   | `temperature` / `top_p` on the ZDR endpoints | Thinking (`reasoning` metadata)                                                                                     | ZDR price per M in / out                    |
| ------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `google/gemini-3.5-flash-lite` | 5 — Google Vertex `global`, `us`, `eu`, `global/flex`, `global/priority` (65,536) | `response_format` and `structured_outputs` on all 5 | advertised by none of the 5                  | `mandatory: true`, `default_enabled: true`, `default_effort: minimal`, `supported_efforts: high/medium/low/minimal` | $0.15–$0.54 / $1.25–$4.50 (flex → priority) |
| `google/gemini-3.5-flash`      | 4 — Google Vertex `global`, `us`, `global/flex`, `global/priority` (65,536)       | `response_format` and `structured_outputs` on all 4 | advertised by all 4                          | `mandatory: true`, `default_effort: medium`                                                                         | $0.75–$2.70 / $4.50–$16.20                  |

Three consequences for the judge:

- **Thinking cannot be turned off.** `mandatory: true` means OpenRouter
  rejects `reasoning: { effort: "none" }`, so the judge sends no `reasoning`
  field at all and inherits the model default, which for
  `google/gemini-3.5-flash-lite` is already the cheapest tier (`minimal`).
- **Reasoning tokens count against `max_tokens`** and are billed at the output
  rate. A budget that thinking alone consumes returns
  `finish_reason: "length"` with empty message content, which the judge reports
  as `LLM judge returned no message content` rather than a category — hence the
  2,000-token default (`DEFAULT_LLM_JUDGE_MAX_TOKENS`), up from the 800 that was
  sized for a model that could run with thinking off.
- **`temperature` is not available under ZDR for the Lite judge.** The judge
  therefore omits the key entirely by default (see `LlmJudgePluginOptions.temperature`).

The list is intentionally curated rather than exhaustive. The live ZDR catalog
contains many additional chat models, including newer Qwen, DeepSeek, Mistral,
GLM, Gemini, Claude, OpenAI, and Grok variants. A candidate should satisfy both
of these conditions before being used as the judge:

1. It has at least one endpoint in the ZDR catalog.
2. That endpoint supports the structured response format required by the judge.

To select a judge model:

```ts
const judge = createLlmJudgePlugin({
  base: openRouter,
  categories,
  llmModel: 'google/gemini-3.5-flash-lite',
  maxTokens: 2000,
});
```

## Recommended Configurations

### Budget-Friendly General Default

```ts
embeddingModel: 'openai/text-embedding-3-small';
llmModel: 'google/gemini-3.5-flash-lite';
```

This is the project default and is a good starting point for ordinary
English-language transaction categorization. The judge sends no `temperature`
and no `reasoning` field with this pairing, so the model samples at its own
defaults and thinks at minimal effort; only the `strict: true` JSON-schema
response format and the prompt make the output shape reproducible.

### Multilingual Embeddings

```ts
embeddingModel: 'baai/bge-m3';
llmModel: 'google/gemini-3.5-flash';
```

This is useful when payees, notes, or transaction descriptions contain several
languages.

### Higher-Quality Classification

```ts
embeddingModel: 'qwen/qwen3-embedding-8b';
llmModel: 'anthropic/claude-sonnet-4.6';
```

This uses larger models and may increase latency, vector storage, and cost.

### OpenAI Judge Alternative

```ts
embeddingModel: 'openai/text-embedding-3-small';
llmModel: 'openai/gpt-5.4-nano';
```

Use this when you prefer an OpenAI judge while keeping the embedding and judge
labs independent.

## Sources

- [OpenRouter ZDR Guide](https://openrouter.ai/docs/guides/features/zdr)
- [OpenRouter Models API](https://openrouter.ai/api/v1/models)
- [OpenRouter Reasoning Tokens](https://openrouter.ai/docs/use-cases/reasoning-tokens)
- [OpenRouter Live ZDR Endpoint Catalog](https://openrouter.ai/api/v1/endpoints/zdr)
- [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter Embeddings API](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request)
- [OpenRouter Embedding Model Collection](https://openrouter.ai/collections/embedding-models)
