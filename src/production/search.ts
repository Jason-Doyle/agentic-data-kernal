import { toSql as vectorToSql } from "pgvector";
import type { AgentOperation } from "../ir.js";
import {
  embeddingSpace,
  type EmbeddingSpace,
  validateEmbeddingVector,
} from "./embeddings.js";

export interface HybridSearchQueryInput extends EmbeddingSpace {
  tenantId: string;
  embedding: number[];
  operation: Extract<AgentOperation, { op: "search" }>;
  systemAt: string;
  validAt: string;
  candidateLimit: number;
  resultLimit: number;
}

export function buildHybridSearchQuery(
  input: HybridSearchQueryInput,
): { text: string; values: unknown[] } {
  const space = embeddingSpace(input);
  validateEmbeddingVector(input.embedding, space.dimensions);
  if (
    !Number.isInteger(input.resultLimit) ||
    input.resultLimit < 1 ||
    !Number.isInteger(input.candidateLimit) ||
    input.candidateLimit < input.resultLimit ||
    input.candidateLimit > 5_000
  ) {
    throw new Error(
      "Search limits must be positive integers and candidates must cover results",
    );
  }
  const vectorType = `vector(${space.dimensions})`;
  const candidateFilters = `
           AND assertion.tenant_id = $14
           AND assertion.system_from <= $3
           AND (
             assertion.system_to IS NULL
             OR assertion.system_to > $3
           )
           AND assertion.valid_from <= $4
           AND (
             assertion.valid_to IS NULL
             OR assertion.valid_to > $4
           )
           AND assertion.status NOT IN ('quarantined', 'deleted')
           AND assertion.embedding_dimensions = ${space.dimensions}
           AND assertion.embedding_model = $10
           AND assertion.embedding_version = $11
           AND ($7::TEXT IS NULL OR assertion.predicate = $7)
           AND ($8::TEXT IS NULL OR assertion.kind = $8)
           AND ($9::TEXT IS NULL OR assertion.perspective = $9)
           AND (
             $5::TEXT IS NULL
             OR EXISTS (
               SELECT 1
               FROM reachable
               WHERE reachable.entity_id = assertion.subject_entity_id
                  OR reachable.entity_id = assertion.object_entity_id
             )
           )`;

  return {
    text: `WITH RECURSIVE reachable(entity_id, depth) AS (
         SELECT $5::TEXT, 0
         WHERE $5::TEXT IS NOT NULL
         UNION
         SELECT
           CASE
             WHEN edge.subject_entity_id = reachable.entity_id
             THEN edge.object_entity_id
             ELSE edge.subject_entity_id
           END,
           reachable.depth + 1
         FROM reachable
         JOIN agentic.assertions edge
           ON (
             edge.subject_entity_id = reachable.entity_id
             AND edge.object_entity_id IS NOT NULL
           )
           OR edge.object_entity_id = reachable.entity_id
         WHERE reachable.depth < $6
           AND edge.tenant_id = $14
           AND edge.system_from <= $3
           AND (edge.system_to IS NULL OR edge.system_to > $3)
           AND edge.valid_from <= $4
           AND (edge.valid_to IS NULL OR edge.valid_to > $4)
           AND edge.status NOT IN ('quarantined', 'deleted')
       ),
       vector_candidates AS MATERIALIZED (
         SELECT
           assertion.tenant_id,
           assertion.assertion_id
         FROM agentic.assertions assertion
         WHERE TRUE
           ${candidateFilters}
         ORDER BY
           (assertion.embedding::${vectorType}) <=> $1::${vectorType}
         LIMIT $12
       ),
       lexical_candidates AS MATERIALIZED (
         SELECT
           assertion.tenant_id,
           assertion.assertion_id
         FROM agentic.assertions assertion
         WHERE assertion.search_document @@ plainto_tsquery('simple', $2)
           ${candidateFilters}
         ORDER BY ts_rank_cd(
           assertion.search_document,
           plainto_tsquery('simple', $2)
         ) DESC
         LIMIT $12
       ),
       candidate_ids AS MATERIALIZED (
         SELECT tenant_id, assertion_id FROM vector_candidates
         UNION
         SELECT tenant_id, assertion_id FROM lexical_candidates
       ),
       scored AS (
         SELECT
           assertion.*,
           ts_rank_cd(
             assertion.search_document,
             plainto_tsquery('simple', $2)
           )::DOUBLE PRECISION AS lexical_score,
           GREATEST(
             0,
             1 - (
               assertion.embedding::${vectorType}
               <=> $1::${vectorType}
             )
           )::DOUBLE PRECISION AS vector_score,
           graph_match.graph_distance
         FROM candidate_ids candidate
         JOIN agentic.assertions assertion
           ON assertion.tenant_id = candidate.tenant_id
          AND assertion.assertion_id = candidate.assertion_id
         LEFT JOIN LATERAL (
           SELECT MIN(reachable.depth)::INTEGER AS graph_distance
           FROM reachable
           WHERE reachable.entity_id = assertion.subject_entity_id
              OR reachable.entity_id = assertion.object_entity_id
         ) graph_match ON TRUE
       )
       SELECT
         scored.*,
         (
           0.45 * lexical_score
           + 0.55 * vector_score
           + CASE
               WHEN graph_distance IS NULL THEN 0
               ELSE 0.1 / (1 + graph_distance)
             END
         )::DOUBLE PRECISION AS combined_score
       FROM scored
       WHERE lexical_score > 0 OR vector_score > 0
       ORDER BY combined_score DESC, assertion_id
       LIMIT $13`,
    values: [
      vectorToSql(input.embedding),
      input.operation.text,
      input.systemAt,
      input.validAt,
      input.operation.relatedToEntityId ?? null,
      input.operation.maxGraphDepth ?? 2,
      input.operation.predicate ?? null,
      input.operation.kind ?? null,
      input.operation.perspective ?? null,
      space.model,
      space.version,
      input.candidateLimit,
      input.resultLimit,
      input.tenantId,
    ],
  };
}
