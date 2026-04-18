export type MetricLabels = Readonly<Record<string, string>>;

function normalizeLabels(labels: MetricLabels = {}): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
}

export interface Counter {
  inc(value?: number, labels?: MetricLabels): void;
  value(labels?: MetricLabels): number;
}

export interface Histogram {
  observe(value: number, labels?: MetricLabels): void;
  summary(labels?: MetricLabels): { count: number; sum: number; min: number; max: number; avg: number };
}

class InMemoryCounter implements Counter {
  private readonly samples = new Map<string, number>();

  inc(value = 1, labels: MetricLabels = {}): void {
    const key = normalizeLabels(labels);
    const current = this.samples.get(key) ?? 0;
    this.samples.set(key, current + value);
  }

  value(labels: MetricLabels = {}): number {
    return this.samples.get(normalizeLabels(labels)) ?? 0;
  }
}

interface HistogramBucket {
  count: number;
  sum: number;
  min: number;
  max: number;
}

class InMemoryHistogram implements Histogram {
  private readonly samples = new Map<string, HistogramBucket>();

  observe(value: number, labels: MetricLabels = {}): void {
    const key = normalizeLabels(labels);
    const bucket = this.samples.get(key) ?? {
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    };

    bucket.count += 1;
    bucket.sum += value;
    bucket.min = Math.min(bucket.min, value);
    bucket.max = Math.max(bucket.max, value);

    this.samples.set(key, bucket);
  }

  summary(labels: MetricLabels = {}): { count: number; sum: number; min: number; max: number; avg: number } {
    const bucket = this.samples.get(normalizeLabels(labels));
    if (!bucket) {
      return { count: 0, sum: 0, min: 0, max: 0, avg: 0 };
    }

    return {
      count: bucket.count,
      sum: bucket.sum,
      min: bucket.min,
      max: bucket.max,
      avg: bucket.count === 0 ? 0 : bucket.sum / bucket.count,
    };
  }
}

export interface MetricsRegistry {
  counter(name: string): Counter;
  histogram(name: string): Histogram;
}

export class InMemoryMetricsRegistry implements MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  counter(name: string): Counter {
    const existing = this.counters.get(name);
    if (existing) return existing;

    const created = new InMemoryCounter();
    this.counters.set(name, created);
    return created;
  }

  histogram(name: string): Histogram {
    const existing = this.histograms.get(name);
    if (existing) return existing;

    const created = new InMemoryHistogram();
    this.histograms.set(name, created);
    return created;
  }
}
