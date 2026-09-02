import type { EncryptedArtifactStore } from "./artifacts.js";
import type { ProductionDatabase } from "./database.js";

export async function reconcileArtifactFiles(
  database: ProductionDatabase,
  artifactStore: EncryptedArtifactStore,
  minimumAgeMs = 60 * 60 * 1_000,
): Promise<{ scanned: number; removed: string[] }> {
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
  const referenced = await database.query<{ storage_key: string }>(
    "SELECT storage_key FROM agentic.artifacts",
  );
  const referencedKeys = new Set(referenced.rows.map((row) => row.storage_key));
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
  return { scanned: files.length, removed };
}
