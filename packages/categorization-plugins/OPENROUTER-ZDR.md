# OpenRouter Zero Data Retention Models

This document records OpenRouter models that are suitable for the
categorization plugins when requests must use Zero Data Retention (ZDR)
endpoints.

OpenRouter availability is provider-specific and changes over time. A model is
listed here when the live ZDR endpoint catalog reports at least one provider
endpoint for it. The live catalog is authoritative:

<https://openrouter.ai/api/v1/endpoints/zdr>

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

## Embedding Models

These embedding model IDs currently have at least one ZDR endpoint:

| Model ID                        | ZDR provider endpoints         | Context length | Notes                                                                               |
| ------------------------------- | ------------------------------ | -------------: | ----------------------------------------------------------------------------------- |
| `openai/text-embedding-3-small` | Azure                          |          8,192 | Recommended general-purpose baseline; the project default.                          |
| `openai/text-embedding-3-large` | Azure                          |          8,192 | Higher-quality OpenAI option with larger vectors and higher cost.                   |
| `qwen/qwen3-embedding-4b`       | DeepInfra                      |         32,768 | Larger multilingual embedding option.                                               |
| `qwen/qwen3-embedding-8b`       | DeepInfra, Nebius, SiliconFlow |  32,000–32,768 | Highest-capacity Qwen embedding option in the current ZDR catalog.                  |
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
metadata filters to isolate the new vectors from older ones.

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
| `google/gemini-2.5-flash`           | Google Vertex                                                                               |      1,048,576 | Fast general-purpose judge with a large context window.      |
| `google/gemini-2.5-flash-lite`      | Google Vertex                                                                               |      1,048,576 | Current project default; cost- and latency-oriented judge.   |
| `google/gemini-2.5-pro`             | Google Vertex                                                                               |      1,048,576 | Higher-quality Google option for ambiguous transactions.     |
| `anthropic/claude-haiku-4.5`        | Amazon Bedrock, Google Vertex                                                               |        200,000 | Fast Anthropic option.                                       |
| `anthropic/claude-sonnet-4.6`       | Amazon Bedrock, Google Vertex                                                               |      1,000,000 | Higher-quality Anthropic option.                             |
| `deepseek/deepseek-v3.2`            | DeepInfra, DigitalOcean, Google Vertex, Mara, Novita, Phala, SambaNova, SiliconFlow, Venice | 32,768–163,840 | Cost-effective open-model judge with broad routing.          |
| `qwen/qwen3-32b`                    | DeepInfra, SiliconFlow                                                                      | 40,960–131,072 | Open-weight judge option.                                    |
| `meta-llama/llama-3.3-70b-instruct` | AkashML, CoreWeave, DeepInfra, Google Vertex, Groq, Novita, Parasail, SambaNova, Together   | 12,288–131,072 | Open-weight judge with broad provider availability.          |

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
  llmModel: 'google/gemini-2.5-flash',
});
```

## Recommended Configurations

### Budget-Friendly General Default

```ts
embeddingModel: 'openai/text-embedding-3-small';
llmModel: 'google/gemini-2.5-flash-lite';
```

This is the project default and is a good starting point for ordinary
English-language transaction categorization.

### Multilingual Embeddings

```ts
embeddingModel: 'baai/bge-m3';
llmModel: 'google/gemini-2.5-flash';
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
- [OpenRouter Live ZDR Endpoint Catalog](https://openrouter.ai/api/v1/endpoints/zdr)
- [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter Embeddings API](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request)
- [OpenRouter Embedding Model Collection](https://openrouter.ai/collections/embedding-models)
