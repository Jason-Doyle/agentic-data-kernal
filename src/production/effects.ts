import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { PoolClient, QueryResultRow } from "pg";
import { Agent, fetch as undiciFetch } from "undici";
import type { JsonValue, MachineState, OrderData } from "../types.js";
import { sha256, stableStringify } from "../util.js";
import type { ProductionConfig } from "./config.js";
import {
  ProductionDatabase,
  type TenantContext,
} from "./database.js";
import type { MetricsRegistry } from "./metrics.js";

type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

interface LeasedEffect extends QueryResultRow {
  tenant_id: string;
  effect_id: string;
  instance_id: string;
  originating_revision: string | number;
  effect_name: string;
  effect_type: string;
  outcome_handler: "retail_order_payment" | "none";
  target_url: string;
  status_url: string;
  request_json: JsonValue;
  idempotency_key: string;
  authorizing_key_id: string;
  purpose: string;
  budget_amount: string;
  currency: string;
  attempt_count: number;
  reconciliation_count: number;
  status: string;
  authorized_at: Date | null;
  authorization_fence: string;
  lease_token: string;
  reconciliation_mode: boolean;
}

interface MachineRow extends QueryResultRow {
  state: string;
  revision: string | number;
  data_json: OrderData;
}

interface DeliveryResult {
  status: "succeeded" | "failed" | "unknown";
  responseStatus: number | null;
  outcome: JsonValue;
}

class OutboundSecurityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OutboundSecurityError";
  }
}

export interface EffectTransport {
  deliver(effect: {
    effectId: string;
    authorizationFence: string;
    idempotencyKey: string;
    targetUrl: string;
    request: JsonValue;
  }): Promise<DeliveryResult>;
  reconcile(effect: {
    effectId: string;
    authorizationFence: string;
    idempotencyKey: string;
    statusUrl: string;
  }): Promise<DeliveryResult>;
}

export class SecureHttpEffectTransport implements EffectTransport {
  public constructor(
    private readonly allowedHosts: Set<string>,
    private readonly timeoutMs: number,
  ) {}

  public async deliver(effect: {
    effectId: string;
    authorizationFence: string;
    idempotencyKey: string;
    targetUrl: string;
    request: JsonValue;
  }): Promise<DeliveryResult> {
    try {
      const { response, parsed } = await performPinnedRequest(
        effect.targetUrl,
        this.allowedHosts,
        this.timeoutMs,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": effect.idempotencyKey,
            "x-agentic-effect-id": effect.effectId,
            "x-agentic-authorization-fence": effect.authorizationFence,
          },
          body: JSON.stringify(effect.request),
        },
      );
      if (response.ok) {
        if (!hasProviderReference(parsed)) {
          return {
            status: "unknown",
            responseStatus: response.status,
            outcome: {
              error: "Successful response omitted providerReference",
              response: parsed,
            },
          };
        }
        return {
          status: "succeeded",
          responseStatus: response.status,
          outcome: parsed,
        };
      }
      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        return {
          status: "unknown",
          responseStatus: response.status,
          outcome: { response: parsed },
        };
      }
      return {
        status: "failed",
        responseStatus: response.status,
        outcome: { response: parsed },
      };
    } catch (error) {
      if (error instanceof OutboundSecurityError) {
        return {
          status: "failed",
          responseStatus: null,
          outcome: { error: error.message },
        };
      }
      return {
        status: "unknown",
        responseStatus: null,
        outcome: {
          error: error instanceof Error ? error.message : "Effect delivery failed",
        },
      };
    }
  }

  public async reconcile(effect: {
    effectId: string;
    authorizationFence: string;
    idempotencyKey: string;
    statusUrl: string;
  }): Promise<DeliveryResult> {
    try {
      const { response, parsed } = await performPinnedRequest(
        effect.statusUrl,
        this.allowedHosts,
        this.timeoutMs,
        {
          method: "GET",
          headers: {
            "idempotency-key": effect.idempotencyKey,
            "x-agentic-effect-id": effect.effectId,
            "x-agentic-authorization-fence": effect.authorizationFence,
          },
        },
      );
      if (response.ok) {
        const status = providerStatus(parsed);
        if (status === "succeeded" && hasProviderReference(parsed)) {
          return {
            status: "succeeded",
            responseStatus: response.status,
            outcome: parsed,
          };
        }
        if (status === "failed") {
          return {
            status: "failed",
            responseStatus: response.status,
            outcome: parsed,
          };
        }
        return {
          status: "unknown",
          responseStatus: response.status,
          outcome: parsed,
        };
      }
      if (
        response.status === 404 ||
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        return {
          status: "unknown",
          responseStatus: response.status,
          outcome: { response: parsed },
        };
      }
      return {
        status: "failed",
        responseStatus: response.status,
        outcome: { response: parsed },
      };
    } catch (error) {
      if (error instanceof OutboundSecurityError) {
        return {
          status: "failed",
          responseStatus: null,
          outcome: { error: error.message },
        };
      }
      return {
        status: "unknown",
        responseStatus: null,
        outcome: {
          error:
            error instanceof Error
              ? error.message
              : "Effect reconciliation failed",
        },
      };
    }
  }
}

export class EffectWorker {
  public constructor(
    private readonly database: ProductionDatabase,
    private readonly transport: EffectTransport,
    private readonly config: Pick<
      ProductionConfig,
      "effectLeaseSeconds" | "effectMaxAttempts"
    >,
    private readonly metrics: MetricsRegistry,
    private readonly logger: Logger,
  ) {}

  public async runOnce(): Promise<boolean> {
    const tenants = await this.database.query<{ tenant_id: string }>(
      `SELECT tenant_id
       FROM agentic_auth.tenants
       WHERE active = TRUE
       ORDER BY tenant_id`,
    );
    for (const tenant of tenants.rows) {
      const effect = await this.leaseNext(tenant.tenant_id);
      if (!effect) {
        continue;
      }
      const started = performance.now();
      const delivery = effect.reconciliation_mode
        ? await this.transport.reconcile({
            effectId: effect.effect_id,
            authorizationFence: effect.authorization_fence,
            idempotencyKey: effect.idempotency_key,
            statusUrl: effect.status_url,
          })
        : await this.transport.deliver({
            effectId: effect.effect_id,
            authorizationFence: effect.authorization_fence,
            idempotencyKey: effect.idempotency_key,
            targetUrl: effect.target_url,
            request: effect.request_json,
          });
      await this.finalize(effect, delivery);
      this.metrics.increment("agentic_effect_attempts_total", {
        status: delivery.status,
        mode: effect.reconciliation_mode ? "reconcile" : "deliver",
      });
      this.metrics.observe(
        "agentic_effect_duration_ms",
        performance.now() - started,
        { status: delivery.status },
      );
      return true;
    }
    return false;
  }

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.runOnce();
      if (!worked) {
        await wait(500, signal);
      }
    }
  }

  private async leaseNext(tenantId: string): Promise<LeasedEffect | null> {
    const context = workerContext(tenantId);
    return this.database.withTenantWriteTransaction(context, async (client) => {
      const result = await client.query<
        LeasedEffect & {
          key_revoked_at: Date | null;
          key_expires_at: Date | null;
          key_scopes: string[];
          key_purposes: string[];
        }
      >(
        `SELECT
           effect.*,
           key.revoked_at AS key_revoked_at,
           key.expires_at AS key_expires_at,
           key.scopes AS key_scopes,
           key.purposes AS key_purposes
         FROM agentic.effect_intents effect
         JOIN agentic_auth.api_keys key
           ON key.key_id = effect.authorizing_key_id
          AND key.tenant_id = effect.tenant_id
         WHERE effect.tenant_id = $1
           AND effect.status IN (
             'planned',
             'unknown',
             'dispatching',
             'reconciling'
           )
           AND effect.next_attempt_at <= clock_timestamp()
           AND (
             effect.status <> 'dispatching'
             OR effect.lease_expires_at < clock_timestamp()
           )
         ORDER BY effect.created_at
         FOR UPDATE OF effect, key SKIP LOCKED
         LIMIT 1`,
        [tenantId],
      );
      const candidate = result.rows[0];
      if (!candidate) {
        return null;
      }

      const alreadyAuthorized = candidate.authorized_at !== null;
      const keyActive =
        candidate.key_revoked_at === null &&
        (candidate.key_expires_at === null ||
          candidate.key_expires_at.getTime() > Date.now()) &&
        candidate.key_scopes.includes("effects:write") &&
        (candidate.key_purposes.includes("*") ||
          candidate.key_purposes.includes(candidate.purpose));

      if (!alreadyAuthorized && !keyActive) {
        await this.cancelUnauthorized(client, candidate);
        this.metrics.increment("agentic_effects_cancelled_total", {
          reason: "authorization",
        });
        return null;
      }

      const leaseToken = randomUUID();
      const authorizationFence =
        candidate.authorization_fence ?? randomUUID();
      const reconciliationMode =
        candidate.status === "reconciling" ||
        candidate.attempt_count >= this.config.effectMaxAttempts;
      const leased = await client.query<LeasedEffect>(
        `UPDATE agentic.effect_intents
         SET status = 'dispatching',
             authorized_at = COALESCE(authorized_at, agentic.next_system_time()),
             authorization_fence = COALESCE(authorization_fence, $1),
             lease_token = $2,
             lease_expires_at = clock_timestamp() + ($3 * INTERVAL '1 second'),
             updated_at = agentic.next_system_time()
         WHERE tenant_id = $4 AND effect_id = $5
         RETURNING *`,
        [
          authorizationFence,
          leaseToken,
          this.config.effectLeaseSeconds,
          tenantId,
          candidate.effect_id,
        ],
      );
      const leasedEffect = leased.rows[0];
      return leasedEffect
        ? { ...leasedEffect, reconciliation_mode: reconciliationMode }
        : null;
    });
  }

  private async finalize(
    effect: LeasedEffect,
    delivery: DeliveryResult,
  ): Promise<void> {
    const context = workerContext(effect.tenant_id, effect.authorizing_key_id);
    await this.database.withTenantWriteTransaction(context, async (client) => {
      const lockedResult = await client.query<LeasedEffect>(
        `SELECT * FROM agentic.effect_intents
         WHERE tenant_id = $1
           AND effect_id = $2
           AND status = 'dispatching'
           AND lease_token = $3
         FOR UPDATE`,
        [effect.tenant_id, effect.effect_id, effect.lease_token],
      );
      const locked = lockedResult.rows[0];
      if (!locked) {
        this.logger.warn(
          { effectId: effect.effect_id },
          "Effect lease was lost before finalization",
        );
        return;
      }
      const attemptNumber =
        locked.attempt_count + locked.reconciliation_count + 1;
      const nextAttemptCount =
        locked.attempt_count + (effect.reconciliation_mode ? 0 : 1);
      const nextReconciliationCount =
        locked.reconciliation_count + (effect.reconciliation_mode ? 1 : 0);
      const nextStatus =
        delivery.status === "unknown"
          ? effect.reconciliation_mode ||
            nextAttemptCount >= this.config.effectMaxAttempts
            ? "reconciling"
            : "unknown"
          : delivery.status;
      const time = await nextSystemTime(client);
      await client.query(
        `INSERT INTO agentic.effect_attempts (
           tenant_id, effect_id, attempt_number, lease_token, status,
           response_status, outcome_json, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          effect.tenant_id,
          effect.effect_id,
          attemptNumber,
          effect.lease_token,
          delivery.status,
          delivery.responseStatus,
          stableStringify(delivery.outcome),
          time,
        ],
      );
      await client.query(
        `UPDATE agentic.effect_intents
         SET status = $1,
             attempt_count = $2,
             reconciliation_count = $3,
             outcome_json = $4,
             lease_token = NULL,
             lease_expires_at = NULL,
             next_attempt_at = CASE
               WHEN $1 IN ('unknown', 'reconciling')
               THEN clock_timestamp() + ($5 * INTERVAL '1 second')
               ELSE clock_timestamp()
             END,
             updated_at = $6
         WHERE tenant_id = $7 AND effect_id = $8`,
        [
          nextStatus,
          nextAttemptCount,
          nextReconciliationCount,
          stableStringify(delivery.outcome),
          retryDelaySeconds(nextReconciliationCount),
          time,
          effect.tenant_id,
          effect.effect_id,
        ],
      );
      if (delivery.status === "unknown") {
        return;
      }
      if (locked.outcome_handler === "retail_order_payment") {
        await this.finishRetailOrder(
          client,
          locked,
          delivery.status,
          time,
        );
      }
      await settleEffectBudget(
        client,
        locked,
        delivery.status,
        this.logger,
      );
    });
  }

  private async finishRetailOrder(
    client: PoolClient,
    effect: LeasedEffect,
    status: "succeeded" | "failed",
    time: Date,
  ): Promise<void> {
    const machineResult = await client.query<MachineRow>(
      `SELECT state, revision, data_json
       FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2
       FOR UPDATE`,
      [effect.tenant_id, effect.instance_id],
    );
    const machine = machineResult.rows[0];
    if (!machine || machine.state !== "payment_pending") {
      throw new Error("Effect machine was not payment_pending");
    }
    if (status === "succeeded") {
      const inventory = await client.query(
        `UPDATE agentic.inventory
         SET quantity_on_hand = quantity_on_hand - $1,
             quantity_reserved = quantity_reserved - $1,
             version = version + 1,
             updated_at = $2
         WHERE tenant_id = $3 AND sku = $4 AND location = $5
           AND quantity_on_hand >= $1
           AND quantity_reserved >= $1`,
        [
          machine.data_json.quantity,
          time,
          effect.tenant_id,
          machine.data_json.sku,
          machine.data_json.location,
        ],
      );
      if (inventory.rowCount !== 1) {
        throw new Error("Reserved inventory was unavailable for effect commit");
      }
    } else {
      await releaseOrderInventory(client, effect.tenant_id, machine.data_json, time);
    }
    const nextState: MachineState =
      status === "succeeded" ? "confirmed" : "failed";
    const nextRevision = Number(machine.revision) + 1;
    await client.query(
      `UPDATE agentic.machine_instances
       SET state = $1, revision = $2, terminal = TRUE, updated_at = $3
       WHERE tenant_id = $4 AND instance_id = $5`,
      [
        nextState,
        nextRevision,
        time,
        effect.tenant_id,
        effect.instance_id,
      ],
    );
    await insertHistory(
      client,
      effect.tenant_id,
      effect.instance_id,
      nextRevision,
      `payment_${status}`,
      "payment_pending",
      nextState,
      machine.data_json,
      time,
    );
  }

  private async cancelUnauthorized(
    client: PoolClient,
    effect: LeasedEffect,
  ): Promise<void> {
    const time = await nextSystemTime(client);
    await client.query(
      `UPDATE agentic.effect_intents
       SET status = 'cancelled', updated_at = $1
       WHERE tenant_id = $2 AND effect_id = $3`,
      [time, effect.tenant_id, effect.effect_id],
    );
    await client.query(
      `UPDATE agentic_auth.api_keys
       SET effect_budget_reserved = GREATEST(
         0,
         effect_budget_reserved - $1
       )
       WHERE key_id = $2 AND tenant_id = $3`,
      [effect.budget_amount, effect.authorizing_key_id, effect.tenant_id],
    );
    if (effect.outcome_handler !== "retail_order_payment") {
      return;
    }
    const machineResult = await client.query<MachineRow>(
      `SELECT state, revision, data_json
       FROM agentic.machine_instances
       WHERE tenant_id = $1 AND instance_id = $2
       FOR UPDATE`,
      [effect.tenant_id, effect.instance_id],
    );
    const machine = machineResult.rows[0];
    if (!machine || machine.state !== "payment_pending") {
      return;
    }
    await releaseOrderInventory(client, effect.tenant_id, machine.data_json, time);
    const nextRevision = Number(machine.revision) + 1;
    await client.query(
      `UPDATE agentic.machine_instances
       SET state = 'failed', revision = $1, terminal = TRUE, updated_at = $2
       WHERE tenant_id = $3 AND instance_id = $4`,
      [nextRevision, time, effect.tenant_id, effect.instance_id],
    );
    await insertHistory(
      client,
      effect.tenant_id,
      effect.instance_id,
      nextRevision,
      "effect_authorization_cancelled",
      "payment_pending",
      "failed",
      machine.data_json,
      time,
    );
  }
}

function workerContext(
  tenantId: string,
  keyId: string = randomUUID(),
): TenantContext {
  return {
    tenantId,
    principalId: "effect-worker",
    keyId,
    purpose: "effect-dispatch",
    scopes: new Set(["effects:reconcile"]),
  };
}

async function validateOutboundUrl(
  value: string,
  allowedHosts: Set<string>,
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OutboundSecurityError("Effect target is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new OutboundSecurityError("Effect targets must use HTTPS");
  }
  const hostname = url.hostname.toLowerCase();
  if (!allowedHosts.has(hostname)) {
    throw new OutboundSecurityError(`Effect host ${hostname} is not allowlisted`);
  }
  if (url.username || url.password) {
    throw new OutboundSecurityError("Effect URLs cannot contain credentials");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivate(address))) {
    throw new OutboundSecurityError(
      "Effect host resolved to a private or reserved address",
    );
  }

  const selected = addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new OutboundSecurityError("Effect host had no usable address");
  }
  return {
    url,
    address: selected.address,
    family: selected.family,
  };
}

function isPrivate(address: string): boolean {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    if (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized)
    ) {
      return true;
    }
    if (normalized.startsWith("::ffff:")) {
      return isPrivate(normalized.slice(7));
    }
    return false;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

async function readLimitedBody(
  response: UndiciResponse,
  maximumBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maximumBytes) {
    throw new Error("Effect response exceeded the maximum size");
  }

  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("Effect response exceeded the maximum size");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function performPinnedRequest(
  urlValue: string,
  allowedHosts: Set<string>,
  timeoutMs: number,
  request: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  },
): Promise<{ response: UndiciResponse; parsed: JsonValue }> {
  const target = await validateOutboundUrl(urlValue, allowedHosts);
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (
          typeof options === "object" &&
          "all" in options &&
          options.all
        ) {
          callback(null, [
            { address: target.address, family: target.family },
          ]);
          return;
        }
        callback(null, target.address, target.family);
      },
    },
  });
  try {
    const response = await undiciFetch(target.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher,
    });
    const parsed = parseJsonBody(
      await readLimitedBody(response, 1_000_000),
    );
    return { response, parsed };
  } finally {
    await dispatcher.close();
  }
}

function parseJsonBody(body: string): JsonValue {
  if (body.length === 0) {
    return {};
  }
  try {
    return JSON.parse(body) as JsonValue;
  } catch {
    return { raw: body.slice(0, 10_000) };
  }
}

function hasProviderReference(value: JsonValue): boolean {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    typeof value.providerReference === "string" &&
    value.providerReference.length > 0
  );
}

function providerStatus(
  value: JsonValue,
): "succeeded" | "failed" | "pending" | null {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    typeof value.status !== "string"
  ) {
    return null;
  }
  return value.status === "succeeded" ||
    value.status === "failed" ||
    value.status === "pending"
    ? value.status
    : null;
}

async function settleEffectBudget(
  client: PoolClient,
  effect: LeasedEffect,
  status: "succeeded" | "failed",
  logger: Logger,
): Promise<void> {
  const result =
    status === "succeeded"
      ? await client.query(
          `UPDATE agentic_auth.api_keys
           SET effect_budget_reserved = GREATEST(
                 0,
                 effect_budget_reserved - $1
               ),
               effect_budget_spent = effect_budget_spent + $1
           WHERE key_id = $2 AND tenant_id = $3`,
          [
            effect.budget_amount,
            effect.authorizing_key_id,
            effect.tenant_id,
          ],
        )
      : await client.query(
          `UPDATE agentic_auth.api_keys
           SET effect_budget_reserved = GREATEST(
             0,
             effect_budget_reserved - $1
           )
           WHERE key_id = $2 AND tenant_id = $3`,
          [
            effect.budget_amount,
            effect.authorizing_key_id,
            effect.tenant_id,
          ],
        );
  if (result.rowCount !== 1) {
    logger.error(
      {
        effectId: effect.effect_id,
        keyId: effect.authorizing_key_id,
        status,
      },
      "Effect terminalized without a matching budget record",
    );
  }
}

function retryDelaySeconds(reconciliationCount: number): number {
  return Math.min(3_600, 30 * 2 ** Math.min(reconciliationCount, 6));
}

async function nextSystemTime(client: PoolClient): Promise<Date> {
  const result = await client.query<{ system_time: Date }>(
    "SELECT agentic.next_system_time() AS system_time",
  );
  const value = result.rows[0]?.system_time;
  if (!value) {
    throw new Error("System time allocation failed");
  }
  return value;
}

async function releaseOrderInventory(
  client: PoolClient,
  tenantId: string,
  order: OrderData,
  time: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE agentic.inventory
     SET quantity_reserved = quantity_reserved - $1,
         version = version + 1,
         updated_at = $2
     WHERE tenant_id = $3 AND sku = $4 AND location = $5
       AND quantity_reserved >= $1`,
    [order.quantity, time, tenantId, order.sku, order.location],
  );
  if (result.rowCount !== 1) {
    throw new Error("Reserved inventory was unavailable for release");
  }
}

async function insertHistory(
  client: PoolClient,
  tenantId: string,
  instanceId: string,
  revision: number,
  transition: string,
  priorState: MachineState,
  nextState: MachineState,
  data: OrderData,
  time: Date,
): Promise<void> {
  const eventId = `event_${sha256(
    tenantId,
    instanceId,
    String(revision),
    transition,
  ).slice(0, 32)}`;
  await client.query(
    `INSERT INTO agentic.machine_history (
       tenant_id, instance_id, revision, event_id, transition_name,
       prior_state, new_state, data_json, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tenantId,
      instanceId,
      revision,
      eventId,
      transition,
      priorState,
      nextState,
      data,
      time,
    ],
  );
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
