DO $$
DECLARE
  installed_version INTEGER[];
BEGIN
  SELECT string_to_array(extversion, '.')::INTEGER[]
  INTO installed_version
  FROM pg_extension
  WHERE extname = 'vector';

  IF installed_version IS NULL OR installed_version < ARRAY[0, 8, 0] THEN
    RAISE EXCEPTION 'pgvector 0.8.0 or newer is required';
  END IF;
END;
$$;

DROP INDEX agentic.assertions_embedding_hnsw;

ALTER TABLE agentic.assertions
  ADD COLUMN embedding_dimensions INTEGER;

UPDATE agentic.assertions
SET embedding_dimensions = vector_dims(embedding);

ALTER TABLE agentic.assertions
  ALTER COLUMN embedding_dimensions SET NOT NULL,
  ALTER COLUMN embedding TYPE vector USING embedding::vector;

ALTER TABLE agentic.assertions
  ADD CONSTRAINT assertions_embedding_dimensions
  CHECK (
    embedding_dimensions BETWEEN 1 AND 2000
    AND vector_dims(embedding) = embedding_dimensions
    AND vector_norm(embedding) > 0
  );

CREATE TABLE agentic.embedding_configuration (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  model TEXT NOT NULL,
  version TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 2000),
  configured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DO $$
DECLARE
  space_count INTEGER;
BEGIN
  SELECT count(*)
  INTO space_count
  FROM (
    SELECT DISTINCT
      embedding_model,
      embedding_version,
      embedding_dimensions
    FROM agentic.assertions
  ) spaces;

  IF space_count > 1 THEN
    RAISE EXCEPTION
      'Existing assertions contain multiple embedding spaces';
  END IF;

  IF space_count = 1 THEN
    INSERT INTO agentic.embedding_configuration (
      singleton,
      model,
      version,
      dimensions
    )
    SELECT
      TRUE,
      embedding_model,
      embedding_version,
      embedding_dimensions
    FROM agentic.assertions
    LIMIT 1;
  END IF;
END;
$$;

CREATE FUNCTION agentic.enforce_embedding_configuration()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  configured agentic.embedding_configuration%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtext('agentic-data-embedding-space')
  );

  SELECT *
  INTO configured
  FROM agentic.embedding_configuration
  WHERE singleton = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Embedding configuration has not been initialized';
  END IF;

  IF NEW.embedding_model IS DISTINCT FROM configured.model
     OR NEW.embedding_version IS DISTINCT FROM configured.version THEN
    RAISE EXCEPTION
      'Assertion embedding model or version does not match database configuration';
  END IF;

  IF vector_dims(NEW.embedding) <> configured.dimensions THEN
    RAISE EXCEPTION
      'Assertion embedding dimensions do not match database configuration';
  END IF;

  NEW.embedding_dimensions := configured.dimensions;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assertions_embedding_configuration
BEFORE INSERT OR UPDATE OF
  embedding,
  embedding_model,
  embedding_version,
  embedding_dimensions
ON agentic.assertions
FOR EACH ROW
EXECUTE FUNCTION agentic.enforce_embedding_configuration();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentic_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE
      ON agentic.embedding_configuration
      FROM agentic_app;
    GRANT SELECT
      ON agentic.embedding_configuration
      TO agentic_app;
  END IF;
END;
$$;
