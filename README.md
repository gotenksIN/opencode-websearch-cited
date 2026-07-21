LLM-grounded web search plugin for [OpenCode V2](https://v2.opencode.ai), with inline citations and a `Sources:` list when available.

The plugin exposes one directly callable tool, `websearch_cited`, backed by the web search APIs from:

- [Google](https://ai.google.dev/gemini-api/docs/google-search)
- [OpenAI](https://platform.openai.com/docs/guides/tools-web-search)
- [OpenRouter](https://openrouter.ai/docs/guides/features/plugins/web-search)

Example output:

```markdown
Answer with citations[1] based on web search results[2].

Sources:
[1] Example Source (https://example.test/source-1)
[2] Another Source (https://example.test/source-2)
```

See [example_output.md](./example_output.md) for a complete example.

## Compatibility

Version 2.x uses the beta OpenCode V2 plugin API and does not load in OpenCode V1. It is currently pinned to the plugin API shipped with `opencode2 v0.0.0-next-15919`.

Use version 1.x of this package with OpenCode V1.

## Installation

Choose one provider and model in the plugin options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-websearch-cited-fork@2.0.0",
      "options": {
        "provider": "google",
        "model": "gemini-2.5-flash"
      }
    }
  ]
}
```

Supported `provider` values are `google`, `openai`, and `openrouter`. Both `provider` and `model` are required.

OpenCode does not automatically upgrade a pinned plugin version. Update the package version after installing a compatible release.

## Authentication

Run `/connect` in OpenCode V2 and connect the provider selected in the plugin options. The plugin resolves the active connection when the tool runs, including stored keys, environment connections, and OpenAI OAuth credentials.

Provider `settings.apiKey` is also used when there is no active integration connection. Use environment substitution rather than storing a key directly:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "google": {
      "settings": {
        "apiKey": "{env:GOOGLE_GENERATIVE_AI_API_KEY}"
      }
    }
  }
}
```

The V1 `opencode-antigravity-auth` plugin does not load in OpenCode V2. Google OAuth through that plugin is therefore not a supported V2 authentication path; use a Google API key until a compatible V2 integration is available.

## Provider Settings

The plugin reads normal provider and selected-model `settings` for request behavior. For example, configure a Google-compatible proxy with `settings.baseURL`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "google": {
      "settings": {
        "baseURL": "https://proxy.example.test/v1beta"
      }
    }
  }
}
```

The OpenAI client recognizes these settings:

- `reasoningEffort`
- `reasoningSummary`
- `textVerbosity`
- `store`
- `include`

Selected-model settings override provider settings.

If authentication or plugin options are missing, `websearch_cited` throws an error that OpenCode displays to the agent.

## Development

This repository uses Bun and TypeScript.

```bash
bun install
bun check
bun test:agent
bun run build
```

To test a local checkout with OpenCode V2, use an explicit local package entry and pass the same options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///path/to/opencode-websearch-cited/index.ts",
      "options": {
        "provider": "google",
        "model": "gemini-2.5-flash"
      }
    }
  ]
}
```

Confirm that OpenCode loaded the plugin:

```bash
opencode2 api get /api/plugin
```

The active plugin list should contain `opencode.websearch-cited`.
