export const schemaSql = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS logical_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_millis INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO logical_clock (id, last_millis) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS entities (
  tenant_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, entity_id)
) STRICT;

CREATE TABLE IF NOT EXISTS artifacts (
  tenant_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  content TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  retention_policy TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, artifact_id)
) STRICT;

CREATE TABLE IF NOT EXISTS assertions (
  tenant_id TEXT NOT NULL,
  assertion_id TEXT NOT NULL,
  subject_entity_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_json TEXT NOT NULL,
  object_key TEXT NOT NULL,
  object_entity_id TEXT,
  kind TEXT NOT NULL,
  perspective TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  system_from TEXT NOT NULL,
  system_to TEXT,
  strength_type TEXT NOT NULL,
  strength_json TEXT NOT NULL,
  authority INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'disputed', 'superseded', 'expired', 'quarantined', 'deleted')
  ),
  source_artifact_id TEXT,
  basis_json TEXT,
  supersedes_assertion_id TEXT,
  search_text TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, assertion_id),
  FOREIGN KEY (tenant_id, subject_entity_id)
    REFERENCES entities (tenant_id, entity_id),
  FOREIGN KEY (tenant_id, object_entity_id)
    REFERENCES entities (tenant_id, entity_id),
  FOREIGN KEY (tenant_id, source_artifact_id)
    REFERENCES artifacts (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, supersedes_assertion_id)
    REFERENCES assertions (tenant_id, assertion_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (system_to IS NULL OR system_to > system_from)
) STRICT;

CREATE INDEX IF NOT EXISTS assertions_subject_predicate
  ON assertions (tenant_id, subject_entity_id, predicate, perspective);
CREATE INDEX IF NOT EXISTS assertions_object_entity
  ON assertions (tenant_id, object_entity_id, predicate);
CREATE INDEX IF NOT EXISTS assertions_time
  ON assertions (tenant_id, system_from, system_to, valid_from, valid_to);

CREATE VIRTUAL TABLE IF NOT EXISTS assertion_fts USING fts5(
  tenant_id UNINDEXED,
  assertion_id UNINDEXED,
  search_text,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS inventory (
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  location TEXT NOT NULL,
  quantity_on_hand INTEGER NOT NULL CHECK (quantity_on_hand >= 0),
  quantity_reserved INTEGER NOT NULL CHECK (quantity_reserved >= 0),
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, sku, location),
  CHECK (quantity_reserved <= quantity_on_hand)
) STRICT;

CREATE TABLE IF NOT EXISTS machine_instances (
  tenant_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  machine_type TEXT NOT NULL,
  state TEXT NOT NULL,
  data_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, instance_id),
  CHECK (machine_type = 'retail_order' OR instance_id NOT LIKE 'order:%')
) STRICT;

CREATE TABLE IF NOT EXISTS machine_inbox (
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  accepted_revision INTEGER NOT NULL,
  outcome_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, source, source_event_id),
  FOREIGN KEY (tenant_id, instance_id)
    REFERENCES machine_instances (tenant_id, instance_id)
) STRICT;

CREATE TABLE IF NOT EXISTS machine_history (
  tenant_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  transition_name TEXT NOT NULL,
  prior_state TEXT NOT NULL,
  new_state TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, instance_id, revision),
  FOREIGN KEY (tenant_id, instance_id)
    REFERENCES machine_instances (tenant_id, instance_id)
) STRICT;

CREATE TABLE IF NOT EXISTS timers (
  tenant_id TEXT NOT NULL,
  timer_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  originating_revision INTEGER NOT NULL,
  timer_name TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, timer_id),
  UNIQUE (tenant_id, instance_id, originating_revision, timer_name),
  FOREIGN KEY (tenant_id, instance_id)
    REFERENCES machine_instances (tenant_id, instance_id)
) STRICT;

CREATE INDEX IF NOT EXISTS timers_due
  ON timers (tenant_id, status, due_at);

CREATE TABLE IF NOT EXISTS effect_intents (
  tenant_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  originating_revision INTEGER NOT NULL,
  effect_name TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  outcome_handler TEXT NOT NULL DEFAULT 'retail_order_payment' CHECK (
    outcome_handler IN ('retail_order_payment', 'none')
  ),
  target TEXT NOT NULL,
  status_url TEXT,
  request_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  decision_assertion_id TEXT,
  policy_assertion_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'unknown', 'succeeded', 'failed', 'cancelled')
  ),
  attempt_count INTEGER NOT NULL,
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, effect_id),
  UNIQUE (tenant_id, instance_id, originating_revision, effect_name),
  FOREIGN KEY (tenant_id, instance_id)
    REFERENCES machine_instances (tenant_id, instance_id),
  FOREIGN KEY (tenant_id, instance_id, originating_revision)
    REFERENCES machine_history (tenant_id, instance_id, revision),
  FOREIGN KEY (tenant_id, decision_assertion_id)
    REFERENCES assertions (tenant_id, assertion_id),
  FOREIGN KEY (tenant_id, policy_assertion_id)
    REFERENCES assertions (tenant_id, assertion_id)
) STRICT;

CREATE TABLE IF NOT EXISTS effect_attempts (
  tenant_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, effect_id, attempt_number),
  FOREIGN KEY (tenant_id, effect_id)
    REFERENCES effect_intents (tenant_id, effect_id)
) STRICT;

CREATE TABLE IF NOT EXISTS lineage_edges (
  tenant_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (
    relation IN (
      'evidence_for',
      'supports',
      'contradicts',
      'governs',
      'authorizes',
      'produces',
      'verifies'
    )
  ),
  from_artifact_id TEXT,
  from_assertion_id TEXT,
  from_instance_id TEXT,
  from_revision INTEGER,
  from_effect_id TEXT,
  to_artifact_id TEXT,
  to_assertion_id TEXT,
  to_instance_id TEXT,
  to_revision INTEGER,
  to_effect_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, edge_id),
  FOREIGN KEY (tenant_id, from_artifact_id)
    REFERENCES artifacts (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, from_assertion_id)
    REFERENCES assertions (tenant_id, assertion_id),
  FOREIGN KEY (tenant_id, from_instance_id, from_revision)
    REFERENCES machine_history (tenant_id, instance_id, revision),
  FOREIGN KEY (tenant_id, from_effect_id)
    REFERENCES effect_intents (tenant_id, effect_id),
  FOREIGN KEY (tenant_id, to_artifact_id)
    REFERENCES artifacts (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, to_assertion_id)
    REFERENCES assertions (tenant_id, assertion_id),
  FOREIGN KEY (tenant_id, to_instance_id, to_revision)
    REFERENCES machine_history (tenant_id, instance_id, revision),
  FOREIGN KEY (tenant_id, to_effect_id)
    REFERENCES effect_intents (tenant_id, effect_id),
  CHECK (
    (from_instance_id IS NULL) = (from_revision IS NULL)
  ),
  CHECK (
    (to_instance_id IS NULL) = (to_revision IS NULL)
  ),
  CHECK (
    (
      (from_artifact_id IS NOT NULL)
      + (from_assertion_id IS NOT NULL)
      + (from_instance_id IS NOT NULL)
      + (from_effect_id IS NOT NULL)
    ) = 1
  ),
  CHECK (
    (
      (to_artifact_id IS NOT NULL)
      + (to_assertion_id IS NOT NULL)
      + (to_instance_id IS NOT NULL)
      + (to_effect_id IS NOT NULL)
    ) = 1
  )
) STRICT;

CREATE INDEX IF NOT EXISTS lineage_from_assertion
  ON lineage_edges (tenant_id, from_assertion_id);
CREATE INDEX IF NOT EXISTS lineage_to_assertion
  ON lineage_edges (tenant_id, to_assertion_id);
CREATE INDEX IF NOT EXISTS lineage_from_effect
  ON lineage_edges (tenant_id, from_effect_id);
CREATE INDEX IF NOT EXISTS lineage_to_effect
  ON lineage_edges (tenant_id, to_effect_id);

CREATE TABLE IF NOT EXISTS execution_receipts (
  tenant_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  operation TEXT NOT NULL,
  snapshot_time TEXT NOT NULL,
  evidence_manifest_json TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id)
) STRICT;

CREATE INDEX IF NOT EXISTS receipts_request
  ON execution_receipts (tenant_id, request_id);

CREATE TABLE IF NOT EXISTS idempotency_results (
  tenant_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, operation_key)
) STRICT;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`;
