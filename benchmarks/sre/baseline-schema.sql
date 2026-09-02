CREATE TABLE incidents (
  incident_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  terminal BOOLEAN NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE observations (
  observation_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (incident_id),
  predicate TEXT NOT NULL,
  value JSONB NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE hypotheses (
  hypothesis_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (incident_id),
  cause TEXT NOT NULL,
  probability DOUBLE PRECISION NOT NULL,
  authority INTEGER NOT NULL,
  supersedes_id TEXT REFERENCES hypotheses (hypothesis_id),
  active BOOLEAN NOT NULL
);

CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (incident_id),
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses (hypothesis_id),
  policy TEXT NOT NULL,
  action TEXT NOT NULL
);

CREATE TABLE effects (
  effect_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (incident_id),
  provider_namespace TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request JSONB NOT NULL,
  status TEXT NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  outcome JSONB,
  UNIQUE (provider_namespace, idempotency_key)
);

CREATE TABLE effect_attempts (
  effect_id TEXT NOT NULL REFERENCES effects (effect_id),
  attempt_number INTEGER NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome JSONB NOT NULL,
  PRIMARY KEY (effect_id, attempt_number)
);

CREATE TABLE lineage (
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  PRIMARY KEY (from_type, from_id, relation, to_type, to_id)
);

CREATE TABLE verifications (
  verification_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (incident_id),
  effect_id TEXT NOT NULL REFERENCES effects (effect_id),
  error_rate DOUBLE PRECISION NOT NULL
);
