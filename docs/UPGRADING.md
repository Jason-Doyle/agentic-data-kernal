# Upgrade and Rollback

## Upgrade from 0.3.0-alpha.5 to 1.0.0

1. Generate and store a 32-byte backup manifest key outside the backup
   location:

   ```powershell
   $env:BACKUP_MANIFEST_KEY = [Convert]::ToBase64String(
     [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
   )
   ```

2. Stop every API and worker replica.
3. Create a coordinated signed backup:

   ```powershell
   .\scripts\backup.ps1
   ```

4. Deploy the `1.0.0` image with workloads disabled.
5. Run `bootstrap-role`.
6. Run `migrate` and require exit code zero.
7. Run administrative artifact reconciliation:

   ```powershell
   node dist\production\cli.js reconcile-artifacts
   ```

8. Start the worker and API.
9. Verify readiness, metrics, one authenticated read, one write/replay, and an
   effect reconciliation in a non-production tenant.

The deployment templates document the equivalent gate-off, migrate, and
gate-on sequence.

## Agent Intent clients

Change new clients to `"protocolVersion": "1.0"`. Existing 0.1 clients remain
compatible throughout 1.x.

## Rollback

Application-only rollback is safe only before a migration job begins.

After migration starts, do not deploy an older container against the upgraded
database. Stop all workloads and restore the signed pre-upgrade backup:

```powershell
.\scripts\restore.ps1 `
  -BackupDirectory <verified-backup-directory> `
  -ConfirmRestore
```

The restore script verifies the external manifest signature, archive
checksums, normalized filenames, PostgreSQL restore status, and the exact
migration versions and checksums supported by the restoring runtime.
