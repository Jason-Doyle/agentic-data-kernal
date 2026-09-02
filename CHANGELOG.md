# Changelog

## Unreleased

## 0.2.0-alpha.2

- Made the PostgreSQL embedding model, version, and indexed dimensions
  deployment-configurable up to 2000 dimensions.
- Reworked hybrid search to retrieve bounded HNSW and full-text candidates
  before temporal, graph, and combined-score reranking.
- Added database enforcement for one active embedding space and upgrade-safe
  migration of existing 1536-dimensional assertions.

## 0.2.0-alpha.1

- Added a PostgreSQL 18 and pgvector production profile.
- Added forced tenant row-level security with a non-superuser runtime role.
- Added scoped, purpose-bound API keys with peppered scrypt-derived hashes.
- Added encrypted immutable artifact storage with key rotation support.
- Added OpenAI-compatible 1536-dimensional embeddings without silent fallback.
- Added authenticated HTTP and MCP production interfaces.
- Added budgeted effect intents, authorization fences, DNS-pinned HTTPS
  delivery, unknown outcomes, and provider status reconciliation.
- Added checksum-verified migrations and database-controlled temporal ordering.
- Added coordinated backup and restore with maintenance locking and checksums.
- Added metrics, structured logs, a TLS Caddy edge, load tooling, and
  production integration tests.
- Added runnable library, MCP, HTTP, embedding, effect receiver, and retail
  integration examples.
- Added API, integration, use case, support, contribution, and community
  documentation.
- Added an adoption guide covering demonstrated benefits, unproven benefits,
  operational costs, alternatives, and poor-fit scenarios.
- Added Node and PostgreSQL CI, CodeQL analysis, and dependency update
  configuration.
- Added npm, GHCR, and GitHub release artifacts with package and container
  smoke tests.

## 0.1.0

- Added the embedded SQLite development kernel.
- Added bitemporal assertions, conflict resolution, hybrid retrieval, durable
  retail order state, local HTTP, MCP, CLI, and project documentation.
