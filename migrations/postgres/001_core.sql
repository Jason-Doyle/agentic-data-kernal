CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS agentic;
CREATE SCHEMA IF NOT EXISTS agentic_auth;

CREATE TABLE agentic.system_clock (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_time TIMESTAMPTZ NOT NULL
);

INSERT INTO agentic.system_clock (singleton, last_time)
VALUES (TRUE, clock_timestamp())
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE agentic.maintenance_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  owner TEXT,
  started_at TIMESTAMPTZ
);

INSERT INTO agentic.maintenance_state (singleton, active)
VALUES (TRUE, FALSE)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION agentic.next_system_time()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
  previous_time TIMESTAMPTZ;
  allocated_time TIMESTAMPTZ;
BEGIN
  SELECT last_time
  INTO previous_time
  FROM agentic.system_clock
  WHERE singleton = TRUE
  FOR UPDATE;

  allocated_time := GREATEST(
    clock_timestamp(),
    previous_time + INTERVAL '1 microsecond'
  );

  UPDATE agentic.system_clock
  SET last_time = allocated_time
  WHERE singleton = TRUE;

  RETURN allocated_time;
END;
$$;

CREATE TABLE agentic_auth.tenants (
  tenant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE agentic_auth.api_keys (
  key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES agentic_auth.tenants (tenant_id),
  principal_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  purposes TEXT[] NOT NULL,
  effect_budget_currency TEXT NOT NULL
    CHECK (effect_budget_currency ~ '^[A-Z]{3}$'),
  effect_budget_limit NUMERIC(20, 4) NOT NULL DEFAULT 0
    CHECK (effect_budget_limit >= 0),
  effect_budget_reserved NUMERIC(20, 4) NOT NULL DEFAULT 0
    CHECK (effect_budget_reserved >= 0),
  effect_budget_spent NUMERIC(20, 4) NOT NULL DEFAULT 0
    CHECK (effect_budget_spent >= 0),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (key_id, tenant_id)
);

CREATE INDEX api_keys_tenant ON agentic_auth.api_keys (tenant_id);

CREATE TABLE agentic.entities (
  tenant_id TEXT NOT NULL REFERENCES agentic_auth.tenants (tenant_id),
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  PRIMARY KEY (tenant_id, entity_id)
);

CREATE TABLE agentic.artifacts (
  tenant_id TEXT NOT NULL REFERENCES agentic_auth.tenants (tenant_id),
  artifact_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  sensitivity TEXT NOT NULL,
  retention_policy TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  deleted_at TIMESTAMPTZ,
  deletion_proof_hash TEXT,
  PRIMARY KEY (tenant_id, artifact_id),
  UNIQUE (tenant_id, storage_key)
);

CREATE TABLE agentic.assertions (
  tenant_id TEXT NOT NULL REFERENCES agentic_auth.tenants (tenant_id),
  assertion_id TEXT NOT NULL,
  subject_entity_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_json JSONB NOT NULL,
  object_key TEXT NOT NULL,
  object_entity_id TEXT,
  kind TEXT NOT NULL,
  perspective TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  system_from TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  system_to TIMESTAMPTZ,
  strength_type TEXT NOT NULL,
  strength_json JSONB NOT NULL,
  authority INTEGER NOT NULL CHECK (authority BETWEEN 0 AND 100),
  status TEXT NOT NULL CHECK (
    status IN ('active', 'disputed', 'expired', 'quarantined', 'deleted')
  ),
  source_artifact_id TEXT,
  basis_json JSONB,
  supersedes_assertion_id TEXT,
  search_text TEXT NOT NULL,
  search_document TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', search_text)
  ) STORED,
  embedding VECTOR(1536) NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_version TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, assertion_id),
  FOREIGN KEY (tenant_id, subject_entity_id)
    REFERENCES agentic.entities (tenant_id, entity_id),
  FOREIGN KEY (tenant_id, object_entity_id)
    REFERENCES agentic.entities (tenant_id, entity_id),
  FOREIGN KEY (tenant_id, source_artifact_id)
    REFERENCES agentic.artifacts (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, supersedes_assertion_id)
    REFERENCES agentic.assertions (tenant_id, assertion_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (system_to IS NULL OR system_to > system_from)
);

CREATE INDEX assertions_subject_predicate
  ON agentic.assertions (
    tenant_id,
    subject_entity_id,
    predicate,
    perspective
  );
CREATE INDEX assertions_object_entity
  ON agentic.assertions (tenant_id, object_entity_id, predicate);
CREATE INDEX assertions_time
  ON agentic.assertions (
    tenant_id,
    system_from,
    system_to,
    valid_from,
    valid_to
  );
CREATE INDEX assertions_search_document
  ON agentic.assertions USING GIN (search_document);
CREATE INDEX assertions_embedding_hnsw
  ON agentic.assertions
  USING HNSW (embedding vector_cosine_ops);

CREATE TABLE agentic.inventory (
  tenant_id TEXT NOT NULL REFERENCES agentic_auth.tenants (tenant_id),
  sku TEXT NOT NULL,
  location TEXT NOT NULL,
  quantity_on_hand INTEGER NOT NULL CHECK (quantity_on_hand >= 0),
  quantity_reserved INTEGER NOT NULL CHECK (quantity_reserved >= 0),
  version BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  PRIMARY KEY (tenant_id, sku, location),
  CHECK (quantity_reserved <= quantity_on_hand)
);

CREATE TABLE agentic.machine_instances (
  tenant_id TEXT NOT NULL REFERENCES agentic_auth.tenants (tenant_id),
  instance_id TEXT NOT NULL,
  machine_type TEXT NOT NULL,
  state TEXT NOT NULL,
  data_json JSONB NOT NULL,
  revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, instance_id)
);

CREATE TABLE agentic.machine_history (
  tenant_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  event_id TEXT NOT NULL,
  transition_name TEXT NOT NULL,
  prior_state TEXT NOT NULL,
  new_state TEXT NOT NULL,
  data_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  PRIMARY KEY (tenant_id, instance_id, revision),
  FOREIGN KEY (tenant_id, instance_id)
    REFERENCES agentic.machine_instances (tenant_id, instance_id)
);

CREATE TABLE agentic.timers (
  tenant_id TEXT NOT NULL,
  timer_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  originating_revision BIGINT NOT NULL,
  timer_name TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, timer_id),
  UNIQUE (tenant_id, instance_id, originating_revision, timer_name),
  FOREIGN KEY (tenant_id, instance_id)
    REFERENCES agentic.machine_instances (tenant_id, instance_id)
);

CREATE INDEX timers_due ON agentic.timers (tenant_id, status, due_at);

CREATE TABLE agentic.effect_intents (
  tenant_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  originating_revision BIGINT NOT NULL,
  effect_name TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  target_url TEXT NOT NULL,
  status_url TEXT NOT NULL,
  request_json JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  authorizing_key_id UUID NOT NULL,
  purpose TEXT NOT NULL,
  budget_amount NUMERIC(20, 4) NOT NULL CHECK (budget_amount >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'planned',
      'dispatching',
      'reconciling',
      'unknown',
      'succeeded',
      'failed',
      'cancelled'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  outcome_json JSONB,
  authorized_at TIMESTAMPTZ,
  authorization_fence UUID,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reconciliation_count INTEGER NOT NULL DEFAULT 0
    CHECK (reconciliation_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, effect_id),
  UNIQUE (tenant_id, instance_id, originating_revision, effect_name),
  FOREIGN KEY (tenant_id, instance_id)
    REFERENCES agentic.machine_instances (tenant_id, instance_id),
  FOREIGN KEY (authorizing_key_id, tenant_id)
    REFERENCES agentic_auth.api_keys (key_id, tenant_id)
);

CREATE INDEX effects_dispatch
  ON agentic.effect_intents (tenant_id, status, created_at);

CREATE TABLE agentic.effect_attempts (
  tenant_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  lease_token UUID NOT NULL,
  status TEXT NOT NULL,
  response_status INTEGER,
  outcome_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  PRIMARY KEY (tenant_id, effect_id, attempt_number),
  FOREIGN KEY (tenant_id, effect_id)
    REFERENCES agentic.effect_intents (tenant_id, effect_id)
);

CREATE TABLE agentic.execution_receipts (
  tenant_id TEXT NOT NULL REFERENCES agentic_auth.tenants (tenant_id),
  receipt_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  operation TEXT NOT NULL,
  snapshot_time TIMESTAMPTZ NOT NULL,
  evidence_manifest_json JSONB NOT NULL,
  result_hash TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  PRIMARY KEY (tenant_id, receipt_id)
);

CREATE INDEX receipts_request
  ON agentic.execution_receipts (tenant_id, request_id);

CREATE TABLE agentic.idempotency_results (
  tenant_id TEXT NOT NULL REFERENCES agentic_auth.tenants (tenant_id),
  principal_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  PRIMARY KEY (tenant_id, principal_id, operation_key)
);

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'entities',
    'artifacts',
    'assertions',
    'inventory',
    'machine_instances',
    'machine_history',
    'timers',
    'effect_intents',
    'effect_attempts',
    'execution_receipts',
    'idempotency_results'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE agentic.%I ENABLE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE agentic.%I FORCE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON agentic.%I
       USING (
         tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')
       )
       WITH CHECK (
         tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')
       )',
      table_name
    );
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentic_app') THEN
    GRANT USAGE ON SCHEMA agentic, agentic_auth TO agentic_app;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA agentic, agentic_auth
      TO agentic_app;
    GRANT USAGE, SELECT
      ON ALL SEQUENCES IN SCHEMA agentic, agentic_auth
      TO agentic_app;
    GRANT EXECUTE
      ON ALL FUNCTIONS IN SCHEMA agentic
      TO agentic_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA agentic
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentic_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA agentic_auth
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentic_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA agentic
      GRANT USAGE, SELECT ON SEQUENCES TO agentic_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA agentic_auth
      GRANT USAGE, SELECT ON SEQUENCES TO agentic_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA agentic
      GRANT EXECUTE ON FUNCTIONS TO agentic_app;
  END IF;
END;
$$;
