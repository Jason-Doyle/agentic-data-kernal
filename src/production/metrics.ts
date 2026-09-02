export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly durationBuckets = new Map<string, number[]>();

  public increment(name: string, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  public observe(
    name: string,
    milliseconds: number,
    labels: Record<string, string> = {},
  ): void {
    const key = metricKey(name, labels);
    const values = this.durationBuckets.get(key) ?? [];
    values.push(milliseconds);
    if (values.length > 10_000) {
      values.splice(0, values.length - 10_000);
    }
    this.durationBuckets.set(key, values);
  }

  public render(): string {
    const lines: string[] = [];
    for (const [key, value] of [...this.counters.entries()].sort()) {
      const { name, labels } = parseMetricKey(key);
      lines.push(`${sanitizeMetricName(name)}${renderLabels(labels)} ${value}`);
    }
    for (const [key, values] of [...this.durationBuckets.entries()].sort()) {
      const { name, labels } = parseMetricKey(key);
      const sorted = [...values].sort((left, right) => left - right);
      const sum = values.reduce((total, value) => total + value, 0);
      const metricName = sanitizeMetricName(name);
      lines.push(
        `${metricName}_count${renderLabels(labels)} ${values.length}`,
        `${metricName}_sum${renderLabels(labels)} ${sum}`,
        `${metricName}_p50${renderLabels(labels)} ${percentile(sorted, 0.5)}`,
        `${metricName}_p95${renderLabels(labels)} ${percentile(sorted, 0.95)}`,
        `${metricName}_p99${renderLabels(labels)} ${percentile(sorted, 0.99)}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}

function metricKey(name: string, labels: Record<string, string>): string {
  return JSON.stringify({ name, labels: Object.entries(labels).sort() });
}

function parseMetricKey(key: string): {
  name: string;
  labels: Array<[string, string]>;
} {
  return JSON.parse(key) as {
    name: string;
    labels: Array<[string, string]>;
  };
}

function renderLabels(labels: Array<[string, string]>): string {
  if (labels.length === 0) {
    return "";
  }
  return `{${labels
    .map(
      ([key, value]) =>
        `${sanitizeMetricName(key)}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
    .join(",")}}`;
}

function sanitizeMetricName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:]/g, "_");
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
}
