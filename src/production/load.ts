export interface LoadOptions {
  baseUrl: string;
  token: string;
  purpose: string;
  tenantId: string;
  principalId: string;
  requests: number;
  concurrency: number;
}

export interface LoadResult {
  requests: number;
  succeeded: number;
  failed: number;
  requestsPerSecond: number;
  p50Milliseconds: number;
  p95Milliseconds: number;
  p99Milliseconds: number;
}

export async function runLoad(options: LoadOptions): Promise<LoadResult> {
  const latencies: number[] = [];
  let next = 0;
  let succeeded = 0;
  let failed = 0;
  const started = performance.now();

  const workers = Array.from(
    { length: Math.max(1, options.concurrency) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= options.requests) {
          return;
        }
        const requestStarted = performance.now();
        const response = await fetch(`${options.baseUrl}/v1/execute`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            "x-agent-purpose": options.purpose,
          },
          body: JSON.stringify({
            protocolVersion: "0.1",
            requestId: `load-${Date.now()}-${index}`,
            principal: {
              tenantId: options.tenantId,
              principalId: options.principalId,
              purpose: options.purpose,
            },
            operation: {
              op: "put_entity",
              entity: {
                entityId: `load-entity:${Date.now()}:${index}`,
                entityType: "load_test",
                canonicalName: `Load Entity ${index}`,
              },
            },
          }),
        });
        latencies.push(performance.now() - requestStarted);
        if (response.ok) {
          succeeded += 1;
        } else {
          failed += 1;
          await response.arrayBuffer();
        }
      }
    },
  );
  await Promise.all(workers);
  const durationSeconds = (performance.now() - started) / 1_000;
  latencies.sort((left, right) => left - right);
  return {
    requests: options.requests,
    succeeded,
    failed,
    requestsPerSecond:
      durationSeconds === 0 ? 0 : options.requests / durationSeconds,
    p50Milliseconds: percentile(latencies, 0.5),
    p95Milliseconds: percentile(latencies, 0.95),
    p99Milliseconds: percentile(latencies, 0.99),
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * fraction) - 1),
  );
  return Math.round((values[index] ?? 0) * 1_000) / 1_000;
}
