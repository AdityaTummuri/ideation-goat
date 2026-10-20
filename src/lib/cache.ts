/** Small TTL cache with insertion-order eviction. */
export class TtlCache<V> {
  private store = new Map<string, { expires: number; value: V }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { expires: Date.now() + this.ttlMs, value });
  }

  clear(): void {
    this.store.clear();
  }
}
