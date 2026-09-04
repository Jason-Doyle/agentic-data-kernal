import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import type { DatabaseConfig } from "./config.js";
import { ProductionDatabase } from "./database.js";

const SCRAM_ITERATIONS = 4096;

export interface RuntimeRoleBootstrapResult {
  role: "agentic_app";
  created: boolean;
}

export async function bootstrapRuntimeRole(
  config: DatabaseConfig,
  password: string,
): Promise<RuntimeRoleBootstrapResult> {
  if (!/^[\x21-\x7E]{16,256}$/.test(password)) {
    throw new Error(
      "APP_DATABASE_PASSWORD must contain 16 to 256 printable ASCII characters without spaces",
    );
  }
  const database = new ProductionDatabase(config);
  try {
    return await database.withSystemTransaction(async (client) => {
      const capability = await client.query<{
        is_superuser: boolean;
        can_create_roles: boolean;
        can_create_databases: boolean;
        can_replicate: boolean;
        can_bypass_rls: boolean;
        target_exists: boolean;
        has_admin_option: boolean;
        target_is_superuser: boolean;
        target_can_create_databases: boolean;
        target_bypasses_rls: boolean;
        target_is_replication: boolean;
      }>(
        `SELECT
           actor_role.rolsuper AS is_superuser,
           actor_role.rolcreaterole AS can_create_roles,
           actor_role.rolcreatedb AS can_create_databases,
           actor_role.rolreplication AS can_replicate,
           actor_role.rolbypassrls AS can_bypass_rls,
           EXISTS (
             SELECT 1
             FROM pg_roles target_role
             WHERE target_role.rolname = 'agentic_app'
           ) AS target_exists,
           EXISTS (
             SELECT 1
             FROM pg_auth_members membership
             JOIN pg_roles target_role
               ON target_role.oid = membership.roleid
             WHERE target_role.rolname = 'agentic_app'
               AND membership.member = actor_role.oid
               AND membership.admin_option
           ) AS has_admin_option,
           COALESCE((
             SELECT target_role.rolsuper
             FROM pg_roles target_role
             WHERE target_role.rolname = 'agentic_app'
           ), FALSE) AS target_is_superuser,
           COALESCE((
             SELECT target_role.rolcreatedb
             FROM pg_roles target_role
             WHERE target_role.rolname = 'agentic_app'
           ), FALSE) AS target_can_create_databases,
           COALESCE((
             SELECT target_role.rolbypassrls
             FROM pg_roles target_role
             WHERE target_role.rolname = 'agentic_app'
           ), FALSE) AS target_bypasses_rls,
           COALESCE((
             SELECT target_role.rolreplication
             FROM pg_roles target_role
             WHERE target_role.rolname = 'agentic_app'
           ), FALSE) AS target_is_replication
         FROM pg_roles actor_role
         WHERE actor_role.rolname = current_user`,
      );
      const permissions = capability.rows[0];
      if (
        !permissions ||
        (
          permissions.is_superuser !== true &&
          permissions.can_create_roles !== true
        )
      ) {
        throw new Error(
          "Runtime role bootstrap requires a PostgreSQL role with CREATEROLE",
        );
      }
      if (
        permissions.target_exists &&
        !permissions.is_superuser &&
        !permissions.has_admin_option
      ) {
        throw new Error(
          "Runtime role bootstrap requires superuser or ADMIN OPTION on agentic_app",
        );
      }
      if (
        permissions.target_exists &&
        !permissions.is_superuser &&
        (
          permissions.target_is_superuser ||
          (
            permissions.target_can_create_databases &&
            !permissions.can_create_databases
          ) ||
          (
            permissions.target_bypasses_rls &&
            !permissions.can_bypass_rls
          ) ||
          (
            permissions.target_is_replication &&
            !permissions.can_replicate
          )
        )
      ) {
        throw new Error(
          "Runtime role bootstrap requires superuser or matching elevated privileges to restrict agentic_app",
        );
      }
      const memberships = await client.query<{ role_name: string }>(
        `SELECT parent_role.rolname AS role_name
         FROM pg_auth_members membership
         JOIN pg_roles member_role
           ON member_role.oid = membership.member
         JOIN pg_roles parent_role
           ON parent_role.oid = membership.roleid
         WHERE member_role.rolname = 'agentic_app'
         ORDER BY parent_role.rolname`,
      );
      if (memberships.rows.length > 0) {
        throw new Error(
          `agentic_app must not belong to other roles: ${memberships.rows
            .map((row) => row.role_name)
            .join(", ")}`,
        );
      }
      const members = await client.query<{ member_name: string }>(
        `SELECT member_role.rolname AS member_name
         FROM pg_auth_members membership
         JOIN pg_roles parent_role
           ON parent_role.oid = membership.roleid
         JOIN pg_roles member_role
           ON member_role.oid = membership.member
         WHERE parent_role.rolname = 'agentic_app'
           AND (
             membership.inherit_option
             OR membership.set_option
             OR NOT membership.admin_option
           )
         ORDER BY member_role.rolname`,
      );
      if (members.rows.length > 0) {
        throw new Error(
          `agentic_app must not have privilege-bearing role members: ${members.rows
            .map((row) => row.member_name)
            .join(", ")}`,
        );
      }
      const ownership = await client.query<{ owns_objects: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_shdepend dependency
           JOIN pg_roles owner_role
             ON owner_role.oid = dependency.refobjid
           WHERE owner_role.rolname = 'agentic_app'
             AND dependency.deptype = 'o'
         ) AS owns_objects`,
      );
      if (ownership.rows[0]?.owns_objects === true) {
        throw new Error(
          "agentic_app must not own database objects",
        );
      }
      const verifier = createScramVerifier(password);
      await client.query(
        "SELECT set_config('agentic.bootstrap_verifier', $1, true)",
        [verifier],
      );
      const existing = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_roles WHERE rolname = 'agentic_app'
         ) AS exists`,
      );
      const attributes = [
        "LOGIN",
        "NOCREATEROLE",
        "NOINHERIT",
        ...(permissions.is_superuser ? ["NOSUPERUSER"] : []),
        ...(permissions.is_superuser || permissions.can_create_databases
          ? ["NOCREATEDB"]
          : []),
        ...(permissions.is_superuser || permissions.can_replicate
          ? ["NOREPLICATION"]
          : []),
        ...(permissions.is_superuser || permissions.can_bypass_rls
          ? ["NOBYPASSRLS"]
          : []),
      ].join(" ");
      await client.query(
        `DO $bootstrap$
         BEGIN
           IF EXISTS (
             SELECT 1 FROM pg_roles WHERE rolname = 'agentic_app'
           ) THEN
             EXECUTE format(
               'ALTER ROLE agentic_app WITH ${attributes} PASSWORD %L',
               current_setting('agentic.bootstrap_verifier')
             );
           ELSE
             EXECUTE format(
               'CREATE ROLE agentic_app WITH ${attributes} PASSWORD %L',
               current_setting('agentic.bootstrap_verifier')
             );
           END IF;
         END
         $bootstrap$`,
      );
      const verified = await client.query<{
        restricted: boolean;
      }>(
        `SELECT (
           rolcanlogin
           AND NOT rolsuper
           AND NOT rolcreatedb
           AND NOT rolcreaterole
           AND NOT rolinherit
           AND NOT rolreplication
           AND NOT rolbypassrls
           AND NOT EXISTS (
             SELECT 1
             FROM pg_auth_members membership
             WHERE membership.member = pg_roles.oid
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_auth_members membership
             WHERE membership.roleid = pg_roles.oid
               AND (
                 membership.inherit_option
                 OR membership.set_option
                 OR NOT membership.admin_option
               )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_shdepend dependency
             WHERE dependency.refobjid = pg_roles.oid
               AND dependency.deptype = 'o'
           )
         ) AS restricted
         FROM pg_roles
         WHERE rolname = 'agentic_app'`,
      );
      if (verified.rows[0]?.restricted !== true) {
        throw new Error(
          "Runtime role bootstrap could not enforce restricted agentic_app attributes",
        );
      }
      return {
        role: "agentic_app",
        created: existing.rows[0]?.exists !== true,
      };
    });
  } finally {
    await database.close();
  }
}

function createScramVerifier(password: string): string {
  const salt = randomBytes(16);
  const saltedPassword = pbkdf2Sync(
    password,
    salt,
    SCRAM_ITERATIONS,
    32,
    "sha256",
  );
  const clientKey = createHmac("sha256", saltedPassword)
    .update("Client Key")
    .digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword)
    .update("Server Key")
    .digest();
  return (
    `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}` +
    `$${storedKey.toString("base64")}:${serverKey.toString("base64")}`
  );
}
