import {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";
import type { ProductionConfig } from "./config.js";
import {
  ProductionDatabase,
  type TenantContext,
} from "./database.js";

export const availableScopes = [
  "data:read",
  "data:write",
  "inventory:admin",
  "orders:write",
  "effects:write",
  "effects:reconcile",
  "workflows:run",
] as const;

export interface CreateApiKeyInput {
  tenantId: string;
  tenantName: string;
  principalId: string;
  scopes: string[];
  purposes: string[];
  effectBudgetCurrency: string;
  effectBudgetLimit: string;
  expiresAt?: string;
}

interface ActiveApiKeyRow {
  key_id: string;
  tenant_id: string;
  principal_id: string;
  scopes: string[];
  purposes: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
  tenant_active: boolean;
}

interface AuthenticationApiKeyRow extends ActiveApiKeyRow {
  token_hash: string;
}

export interface AuthenticatedPrincipal extends TenantContext {
  purposes: Set<string>;
}

export async function createApiKey(
  database: ProductionDatabase,
  config: Pick<ProductionConfig, "authPepper">,
  input: CreateApiKeyInput,
): Promise<{ token: string; keyId: string }> {
  validateScopes(input.scopes);
  if (input.purposes.length === 0) {
    throw new Error("At least one purpose is required");
  }
  if (!/^(0|[1-9]\d{0,15})(\.\d{1,4})?$/.test(input.effectBudgetLimit)) {
    throw new Error(
      "effectBudgetLimit must be a canonical non-negative decimal string",
    );
  }
  if (!/^[A-Z]{3}$/.test(input.effectBudgetCurrency)) {
    throw new Error("effectBudgetCurrency must be a three-letter code");
  }
  const keyId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const token = `adk.${keyId}.${secret}`;
  const tokenHash = await deriveTokenHash(
    token,
    config.authPepper,
    keyId,
  );

  await database.withSystemWriteTransaction(async (client) => {
    await client.query(
      `INSERT INTO agentic_auth.tenants (tenant_id, display_name, active)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (tenant_id) DO UPDATE SET
         display_name = EXCLUDED.display_name`,
      [input.tenantId, input.tenantName],
    );
    await client.query(
      `INSERT INTO agentic_auth.api_keys (
         key_id, tenant_id, principal_id, token_hash, scopes, purposes,
         effect_budget_currency, effect_budget_limit, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        keyId,
        input.tenantId,
        input.principalId,
        tokenHash,
        input.scopes,
        input.purposes,
        input.effectBudgetCurrency,
        input.effectBudgetLimit,
        input.expiresAt ?? null,
      ],
    );
  });
  return { token, keyId };
}

export async function authenticateToken(
  database: ProductionDatabase,
  config: Pick<ProductionConfig, "authPepper">,
  token: string,
  purpose: string,
): Promise<AuthenticatedPrincipal> {
  const parsed = parseToken(token);
  const result = await database.query<AuthenticationApiKeyRow>(
    `SELECT
       k.key_id,
       k.tenant_id,
       k.principal_id,
       k.token_hash,
       k.scopes,
       k.purposes,
       k.expires_at,
       k.revoked_at,
       t.active AS tenant_active
     FROM agentic_auth.api_keys k
     JOIN agentic_auth.tenants t ON t.tenant_id = k.tenant_id
     WHERE k.key_id = $1`,
    [parsed.keyId],
  );
  const row = result.rows[0];
  assertActiveApiKey(row);
  const supplied = Buffer.from(
    await deriveTokenHash(token, config.authPepper, parsed.keyId),
    "hex",
  );
  const expected = Buffer.from(row.token_hash, "hex");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new AuthenticationError("Invalid or revoked API key");
  }
  return principalFromActiveRow(
    {
      key_id: row.key_id,
      tenant_id: row.tenant_id,
      principal_id: row.principal_id,
      scopes: row.scopes,
      purposes: row.purposes,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      tenant_active: row.tenant_active,
    },
    purpose,
  );
}

export async function revalidatePrincipal(
  client: PoolClient,
  principal: AuthenticatedPrincipal,
): Promise<AuthenticatedPrincipal> {
  const result = await client.query<ActiveApiKeyRow>(
    `SELECT
       k.key_id,
       k.tenant_id,
       k.principal_id,
       k.scopes,
       k.purposes,
       k.expires_at,
       k.revoked_at,
       t.active AS tenant_active
     FROM agentic_auth.api_keys k
     JOIN agentic_auth.tenants t ON t.tenant_id = k.tenant_id
     WHERE k.key_id = $1
       AND k.tenant_id = $2
       AND k.principal_id = $3`,
    [principal.keyId, principal.tenantId, principal.principalId],
  );
  const row = result.rows[0];
  assertActiveApiKey(row);
  return principalFromActiveRow(row, principal.purpose);
}

function assertActiveApiKey(
  row: ActiveApiKeyRow | undefined,
): asserts row is ActiveApiKeyRow {
  if (!row || !row.tenant_active || row.revoked_at !== null) {
    throw new AuthenticationError("Invalid or revoked API key");
  }
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    throw new AuthenticationError("API key has expired");
  }
}

function principalFromActiveRow(
  row: ActiveApiKeyRow,
  purpose: string,
): AuthenticatedPrincipal {
  const purposes = new Set(row.purposes);
  if (!purposes.has("*") && !purposes.has(purpose)) {
    throw new AuthorizationError(`Purpose ${purpose} is not allowed`);
  }
  return {
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    keyId: row.key_id,
    purpose,
    scopes: new Set(row.scopes),
    purposes,
  };
}

export async function revokeApiKey(
  client: PoolClient,
  keyId: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE agentic_auth.api_keys
     SET revoked_at = clock_timestamp()
     WHERE key_id = $1 AND revoked_at IS NULL`,
    [keyId],
  );
  if (result.rowCount !== 1) {
    throw new Error("API key was not found or was already revoked");
  }
}

export function requireScope(
  principal: AuthenticatedPrincipal,
  scope: string,
): void {
  if (!principal.scopes.has(scope)) {
    throw new AuthorizationError(`Scope ${scope} is required`);
  }
}

export function operationScope(operation: string): string {
  switch (operation) {
    case "resolve":
    case "search":
    case "get_machine":
    case "list_effects":
    case "explain":
      return "data:read";
    case "put_entity":
    case "put_artifact":
    case "assert":
    case "add_lineage":
      return "data:write";
    case "seed_inventory":
      return "inventory:admin";
    case "reserve_inventory":
      return "orders:write";
    case "request_payment":
    case "request_effect":
      return "effects:write";
    case "record_payment_outcome":
    case "record_effect_outcome":
      return "effects:reconcile";
    case "create_workflow":
    case "advance_workflow":
    case "process_timers":
      return "workflows:run";
    default:
      throw new AuthorizationError(`Unsupported operation ${operation}`);
  }
}

export class AuthenticationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

function parseToken(token: string): { keyId: string } {
  const match = /^adk\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,})$/.exec(token);
  if (!match?.[1]) {
    throw new AuthenticationError("Invalid API key");
  }
  return { keyId: match[1] };
}

function deriveTokenHash(
  token: string,
  pepper: string,
  keyId: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(
      token,
      Buffer.from(`${keyId}:${pepper}`, "utf8"),
      32,
      {
        N: 16_384,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.from(derivedKey).toString("hex"));
      },
    );
  });
}

function validateScopes(scopes: string[]): void {
  const allowed = new Set<string>(availableScopes);
  if (scopes.length === 0) {
    throw new Error("At least one scope is required");
  }
  for (const scope of scopes) {
    if (!allowed.has(scope)) {
      throw new Error(`Unknown scope ${scope}`);
    }
  }
}
