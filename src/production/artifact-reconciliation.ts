import type { EncryptedArtifactStore } from "./artifacts.js";
import type { ProductionDatabase } from "./database.js";

export async function reconcileArtifactFiles(
  database: ProductionDatabase,
  artifactStore: EncryptedArtifactStore,
  minimumAgeMs = 60 * 60 * 1_000,
): Promise<{ scanned: number; verified: number; removed: string[] }> {
  const capability = await database.query<{ can_bypass_rls: boolean }>(
    `SELECT (rolsuper OR rolbypassrls) AS can_bypass_rls
     FROM pg_roles
     WHERE rolname = current_user`,
  );
  if (capability.rows[0]?.can_bypass_rls !== true) {
    throw new Error(
      "Artifact reconciliation requires an administrative BYPASSRLS connection",
    );
  }
  const referenced = await database.query<{
    tenant_id: string;
    artifact_id: string;
    media_type: string;
    content_hash: string;
    storage_key: string;
    encryption_key_id: string;
  }>(
    `SELECT
       tenant_id,
       artifact_id,
       media_type,
       content_hash,
       storage_key,
       encryption_key_id
     FROM agentic.artifacts
     WHERE status = 'active'`,
  );
  const referencedKeys = new Set(referenced.rows.map((row) => row.storage_key));
  for (const artifact of referenced.rows) {
    try {
      await artifactStore.get({
        tenantId: artifact.tenant_id,
        artifactId: artifact.artifact_id,
        mediaType: artifact.media_type,
        contentHash: artifact.content_hash,
        storageKey: artifact.storage_key,
        encryptionKeyId: artifact.encryption_key_id,
      });
    } catch (error) {
      throw new Error(
        `Artifact ${artifact.artifact_id} failed integrity verification`,
        { cause: error },
      );
    }
  }
  const files = await artifactStore.listStoredFiles();
  const cutoff = Date.now() - minimumAgeMs;
  const removed: string[] = [];
  for (const file of files) {
    if (
      !referencedKeys.has(file.storageKey) &&
      file.modifiedAt.getTime() <= cutoff
    ) {
      await artifactStore.removeIfPresent(file.storageKey);
      removed.push(file.storageKey);
    }
  }
  return {
    scanned: files.length,
    verified: referenced.rows.length,
    removed,
  };
}
