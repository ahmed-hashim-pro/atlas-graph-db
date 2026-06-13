class Counter {
  private value = 0;
  inc(by = 1): void {
    this.value += by;
  }
  get(): number {
    return this.value;
  }
}

class Gauge {
  private value = 0;
  inc(): void {
    this.value++;
  }
  dec(): void {
    this.value--;
  }
  set(v: number): void {
    this.value = v;
  }
  get(): number {
    return this.value;
  }
}

const BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000];

class Histogram {
  private readonly counts = new Array<number>(BUCKETS.length).fill(0);
  private sum = 0;
  private total = 0;
  observe(ms: number): void {
    this.sum += ms;
    this.total++;
    for (let i = 0; i < BUCKETS.length; i++) if (ms <= BUCKETS[i]!) this.counts[i]!++;
  }
  render(name: string): string {
    const lines: string[] = [];
    for (let i = 0; i < BUCKETS.length; i++)
      lines.push(`${name}_bucket{le="${BUCKETS[i]}"} ${this.counts[i]}`);
    lines.push(`${name}_bucket{le="+Inf"} ${this.total}`);
    lines.push(`${name}_sum ${this.sum}`);
    lines.push(`${name}_count ${this.total}`);
    return lines.join('\n');
  }
}

export class MetricsRegistry {
  readonly queriesTotal = new Counter();
  readonly wsSubscribers = new Gauge();
  readonly queryLatencyMs = new Histogram();

  render(): string {
    return [
      '# TYPE atlas_queries_total counter',
      `atlas_queries_total ${this.queriesTotal.get()}`,
      '# TYPE atlas_ws_subscribers gauge',
      `atlas_ws_subscribers ${this.wsSubscribers.get()}`,
      '# TYPE atlas_query_latency_ms histogram',
      this.queryLatencyMs.render('atlas_query_latency_ms'),
      '',
    ].join('\n');
  }
}
