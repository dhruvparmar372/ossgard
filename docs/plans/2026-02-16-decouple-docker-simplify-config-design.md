# Decouple Docker & Simplify Config

## Goal

Remove Docker dependency from the ossgard CLI and simplify configuration by consolidating provider URLs into the TOML config file instead of scattered environment variables.

## Changes

### 1. Remove Docker dependency

- Delete `up` and `down` CLI commands (`packages/cli/src/commands/stack.ts`)
- Remove `registerStackCommands(program)` from CLI entry point
- Move `docker-compose.yml` to `deploy/docker-compose.yml` as optional convenience
- Update README: remove Docker from prerequisites, explain running services independently

### 2. New config structure

```toml
[github]
token = "ghp_..."

[llm]
provider = "ollama"                    # "ollama" | "anthropic"
url = "http://localhost:11434"         # provider base URL
model = "llama3"
api_key = ""
batch = false

[embedding]
provider = "ollama"                    # "ollama" | "openai"
url = "http://localhost:11434"         # provider base URL
model = "nomic-embed-text"
api_key = ""
batch = false

[vector_store]
url = "http://localhost:6333"          # Qdrant URL
```

### 3. Removed

- `OLLAMA_URL` env var (replaced by `llm.url` / `embedding.url`)
- `QDRANT_URL` env var (replaced by `vector_store.url`)
- All provider env var overrides (`LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BATCH`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`, `EMBEDDING_BATCH`)
- `docker-compose.yml` from project root
- `up` / `down` CLI commands

### 4. Kept

- `GITHUB_TOKEN` env var — CI/CD override for config token
- `DATABASE_PATH` env var — deployment flexibility
- `PORT` env var — standard server port override
- `CONFIG_PATH` env var — alternate config file location

### 5. Extensibility

The `[vector_store]` section naturally supports future provider field (e.g., `provider = "qdrant"` or `provider = "pinecone"`) without config restructuring.
