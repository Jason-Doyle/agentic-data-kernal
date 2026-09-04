const durationBoundaries = [
  1,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  30_000,
  60_000,
];

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<
    string,
    { buckets: number[]; count: number; sum: number }
  >();

  public increment(name: string, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  public set(
    name: string,
    value: number,
    labels: Record<string, string> = {},
  ): void {
    this.gauges.set(metricKey(name, labels), value);
  }

  public observe(
    name: string,
    milliseconds: number,
    labels: Record<string, string> = {},
  ): void {
    const key = metricKey(name, labels);
    const histogram = this.histograms.get(key) ?? {
      buckets: durationBoundaries.map(() => 0),
      count: 0,
      sum: 0,
    };
    for (let index = 0; index < durationBoundaries.length; index += 1) {
      const boundary = durationBoundaries[index];
      if (boundary !== undefined && milliseconds <= boundary) {
        histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
      }
    }
    histogram.count += 1;
    histogram.sum += milliseconds;
    this.histograms.set(key, histogram);
  }

  public render(): string {
    const lines: string[] = [];
    for (const [key, value] of [...this.counters.entries()].sort()) {
      const { name, labels } = parseMetricKey(key);
      lines.push(`${sanitizeMetricName(name)}${renderLabels(labels)} ${value}`);
    }
    for (const [key, value] of [...this.gauges.entries()].sort()) {
      const { name, labels } = parseMetricKey(key);
      lines.push(`${sanitizeMetricName(name)}${renderLabels(labels)} ${value}`);
    }
    for (const [key, histogram] of [...this.histograms.entries()].sort()) {
      const { name, labels } = parseMetricKey(key);
      const metricName = sanitizeMetricName(name);
      for (let index = 0; index < durationBoundaries.length; index += 1) {
        const boundary = durationBoundaries[index];
        if (boundary === undefined) {
          continue;
        }
        lines.push(
          `${metricName}_bucket${renderLabels([
            ...labels,
            ["le", String(boundary)],
          ])} ${histogram.buckets[index] ?? 0}`,
        );
      }
      lines.push(
        `${metricName}_bucket${renderLabels([
          ...labels,
          ["le", "+Inf"],
        ])} ${histogram.count}`,
        `${metricName}_sum${renderLabels(labels)} ${histogram.sum}`,
        `${metricName}_count${renderLabels(labels)} ${histogram.count}`,
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
  return `{${[...labels]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `${sanitizeMetricName(key)}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
    .join(",")}}`;
}

function sanitizeMetricName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:]/g, "_");
}
