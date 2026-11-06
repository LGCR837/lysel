type Handler = (...args: any[]) => unknown;

export class EventBus {
  private map = new Map<string, Set<Handler>>();

  on(event: string, h: Handler): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(h);
    return () => set!.delete(h);
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.map.get(event);
    if (!set) return;
    for (const h of [...set]) {
      try {
        const r = h(...args);
        if (r instanceof Promise) r.catch(() => {});
      } catch {}
    }
  }
}
