ALTER TABLE agentic.machine_instances
  ADD COLUMN terminal BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE agentic.machine_instances
SET terminal = TRUE
WHERE machine_type = 'retail_order'
  AND state IN ('confirmed', 'cancelled', 'failed');

ALTER TABLE agentic.machine_instances
  ADD CONSTRAINT generic_workflow_reserved_order_namespace
  CHECK (machine_type = 'retail_order' OR instance_id NOT LIKE 'order:%');

ALTER TABLE agentic.effect_intents
  ADD COLUMN outcome_handler TEXT NOT NULL
    DEFAULT 'retail_order_payment'
    CHECK (outcome_handler IN ('retail_order_payment', 'none')),
  ADD COLUMN decision_assertion_id TEXT,
  ADD COLUMN policy_assertion_id TEXT,
  ADD COLUMN provider_namespace TEXT,
  ADD COLUMN request_hash TEXT,
  ADD CONSTRAINT effect_originating_revision
    FOREIGN KEY (tenant_id, instance_id, originating_revision)
    REFERENCES agentic.machine_history (tenant_id, instance_id, revision),
  ADD CONSTRAINT effect_decision_assertion
    FOREIGN KEY (tenant_id, decision_assertion_id)
    REFERENCES agentic.assertions (tenant_id, assertion_id),
  ADD CONSTRAINT effect_policy_assertion
    FOREIGN KEY (tenant_id, policy_assertion_id)
    REFERENCES agentic.assertions (tenant_id, assertion_id);

UPDATE agentic.effect_intents
SET
  provider_namespace = lower(
    regexp_replace(
      substring(target_url FROM '^(https?://[^/]+)'),
      ':443$',
      ''
    )
  ),
  request_hash = 'legacy:' || encode(
    digest(
      effect_type
        || E'\n'
        || target_url
        || E'\n'
        || idempotency_key
        || E'\n'
        || request_json::TEXT,
      'sha256'
    ),
    'hex'
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM agentic.effect_intents
    GROUP BY tenant_id, provider_namespace, idempotency_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Existing effects reuse a provider idempotency key; resolve duplicates before migration 003';
  END IF;
END;
$$;

ALTER TABLE agentic.effect_intents
  ALTER COLUMN provider_namespace SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL,
  ADD CONSTRAINT effect_provider_idempotency
    UNIQUE (tenant_id, provider_namespace, idempotency_key);

CREATE FUNCTION agentic.validate_effect_authority_bindings()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  decision_kind TEXT;
  machine_revision BIGINT;
  machine_terminal BOOLEAN;
  machine_type TEXT;
  policy_kind TEXT;
BEGIN
  SELECT machine.machine_type, machine.revision, machine.terminal
  INTO machine_type, machine_revision, machine_terminal
  FROM agentic.machine_instances machine
  WHERE machine.tenant_id = NEW.tenant_id
    AND machine.instance_id = NEW.instance_id;

  IF NEW.outcome_handler = 'retail_order_payment' THEN
    IF machine_type IS DISTINCT FROM 'retail_order' THEN
      RAISE EXCEPTION
        'Retail payment effects require a retail order workflow';
    END IF;
    IF NEW.decision_assertion_id IS NOT NULL
       OR NEW.policy_assertion_id IS NOT NULL THEN
      RAISE EXCEPTION
        'Retail payment effects cannot carry generic authority bindings';
    END IF;
    RETURN NEW;
  END IF;

  IF machine_type = 'retail_order' THEN
    RAISE EXCEPTION
      'Generic effects cannot target retail order workflows';
  END IF;
  IF machine_terminal
     OR machine_revision IS DISTINCT FROM NEW.originating_revision THEN
    RAISE EXCEPTION
      'Generic effects require the current non-terminal workflow revision';
  END IF;

  IF NEW.decision_assertion_id IS NULL
     OR NEW.policy_assertion_id IS NULL THEN
    RAISE EXCEPTION
      'Generic effects require decision and policy assertions';
  END IF;

  SELECT kind
  INTO decision_kind
  FROM agentic.assertions
  WHERE tenant_id = NEW.tenant_id
    AND assertion_id = NEW.decision_assertion_id;

  SELECT kind
  INTO policy_kind
  FROM agentic.assertions
  WHERE tenant_id = NEW.tenant_id
    AND assertion_id = NEW.policy_assertion_id;

  IF decision_kind IS DISTINCT FROM 'decision' THEN
    RAISE EXCEPTION
      'Generic effects require a decision assertion';
  END IF;
  IF policy_kind IS DISTINCT FROM 'directive' THEN
    RAISE EXCEPTION
      'Generic effects require a directive policy assertion';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER effect_authority_bindings
BEFORE INSERT OR UPDATE OF
  outcome_handler,
  decision_assertion_id,
  policy_assertion_id
ON agentic.effect_intents
FOR EACH ROW
EXECUTE FUNCTION agentic.validate_effect_authority_bindings();

CREATE TABLE agentic.lineage_edges (
  tenant_id TEXT NOT NULL REFERENCES agentic_auth.tenants (tenant_id),
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
  from_revision BIGINT,
  from_effect_id TEXT,
  to_artifact_id TEXT,
  to_assertion_id TEXT,
  to_instance_id TEXT,
  to_revision BIGINT,
  to_effect_id TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT agentic.next_system_time(),
  PRIMARY KEY (tenant_id, edge_id),
  FOREIGN KEY (tenant_id, from_artifact_id)
    REFERENCES agentic.artifacts (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, from_assertion_id)
    REFERENCES agentic.assertions (tenant_id, assertion_id),
  FOREIGN KEY (tenant_id, from_instance_id, from_revision)
    REFERENCES agentic.machine_history (tenant_id, instance_id, revision),
  FOREIGN KEY (tenant_id, from_effect_id)
    REFERENCES agentic.effect_intents (tenant_id, effect_id),
  FOREIGN KEY (tenant_id, to_artifact_id)
    REFERENCES agentic.artifacts (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, to_assertion_id)
    REFERENCES agentic.assertions (tenant_id, assertion_id),
  FOREIGN KEY (tenant_id, to_instance_id, to_revision)
    REFERENCES agentic.machine_history (tenant_id, instance_id, revision),
  FOREIGN KEY (tenant_id, to_effect_id)
    REFERENCES agentic.effect_intents (tenant_id, effect_id),
  CHECK (
    (from_instance_id IS NULL) = (from_revision IS NULL)
  ),
  CHECK (
    (to_instance_id IS NULL) = (to_revision IS NULL)
  ),
  CHECK (
    num_nonnulls(
      from_artifact_id,
      from_assertion_id,
      from_instance_id,
      from_effect_id
    ) = 1
  ),
  CHECK (
    num_nonnulls(
      to_artifact_id,
      to_assertion_id,
      to_instance_id,
      to_effect_id
    ) = 1
  ),
  CHECK (
    NOT (
      (
        from_artifact_id IS NOT NULL
        AND from_artifact_id = to_artifact_id
      )
      OR (
        from_assertion_id IS NOT NULL
        AND from_assertion_id = to_assertion_id
      )
      OR (
        from_instance_id IS NOT NULL
        AND from_instance_id = to_instance_id
        AND from_revision = to_revision
      )
      OR (
        from_effect_id IS NOT NULL
        AND from_effect_id = to_effect_id
      )
    )
  ),
  CHECK (
    (
      relation = 'evidence_for'
      AND from_artifact_id IS NOT NULL
      AND to_assertion_id IS NOT NULL
    )
    OR (
      relation IN ('supports', 'contradicts')
      AND from_assertion_id IS NOT NULL
      AND to_assertion_id IS NOT NULL
    )
    OR (
      relation = 'governs'
      AND from_assertion_id IS NOT NULL
      AND (
        to_assertion_id IS NOT NULL
        OR to_effect_id IS NOT NULL
      )
    )
    OR (
      relation = 'authorizes'
      AND from_assertion_id IS NOT NULL
      AND to_effect_id IS NOT NULL
    )
    OR (
      relation = 'produces'
      AND from_instance_id IS NOT NULL
      AND to_effect_id IS NOT NULL
    )
    OR (
      relation = 'verifies'
      AND from_effect_id IS NOT NULL
      AND to_assertion_id IS NOT NULL
    )
  )
);

CREATE FUNCTION agentic.validate_lineage_semantics()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_kind TEXT;
  target_kind TEXT;
BEGIN
  IF NEW.from_assertion_id IS NOT NULL THEN
    SELECT kind
    INTO source_kind
    FROM agentic.assertions
    WHERE tenant_id = NEW.tenant_id
      AND assertion_id = NEW.from_assertion_id;
  END IF;

  IF NEW.to_assertion_id IS NOT NULL THEN
    SELECT kind
    INTO target_kind
    FROM agentic.assertions
    WHERE tenant_id = NEW.tenant_id
      AND assertion_id = NEW.to_assertion_id;
  END IF;

  IF NEW.relation = 'authorizes'
     AND source_kind IS DISTINCT FROM 'decision' THEN
    RAISE EXCEPTION 'Only decision assertions can authorize effects';
  END IF;
  IF NEW.relation = 'governs'
     AND source_kind IS DISTINCT FROM 'directive' THEN
    RAISE EXCEPTION 'Only directive assertions can govern records';
  END IF;
  IF NEW.relation = 'verifies'
     AND target_kind IS DISTINCT FROM 'observation' THEN
    RAISE EXCEPTION 'Effect verification must be an observation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lineage_semantics
BEFORE INSERT OR UPDATE
ON agentic.lineage_edges
FOR EACH ROW
EXECUTE FUNCTION agentic.validate_lineage_semantics();

CREATE INDEX lineage_from_assertion
  ON agentic.lineage_edges (tenant_id, from_assertion_id)
  WHERE from_assertion_id IS NOT NULL;
CREATE INDEX lineage_to_assertion
  ON agentic.lineage_edges (tenant_id, to_assertion_id)
  WHERE to_assertion_id IS NOT NULL;
CREATE INDEX lineage_from_effect
  ON agentic.lineage_edges (tenant_id, from_effect_id)
  WHERE from_effect_id IS NOT NULL;
CREATE INDEX lineage_to_effect
  ON agentic.lineage_edges (tenant_id, to_effect_id)
  WHERE to_effect_id IS NOT NULL;
CREATE INDEX lineage_from_workflow
  ON agentic.lineage_edges (tenant_id, from_instance_id, from_revision)
  WHERE from_instance_id IS NOT NULL;
CREATE INDEX lineage_to_workflow
  ON agentic.lineage_edges (tenant_id, to_instance_id, to_revision)
  WHERE to_instance_id IS NOT NULL;

ALTER TABLE agentic.lineage_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentic.lineage_edges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agentic.lineage_edges
USING (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
)
WITH CHECK (
  tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON agentic.lineage_edges
      TO agentic_app;
  END IF;
END;
$$;
