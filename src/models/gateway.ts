import { setTimeout as delay } from 'node:timers/promises';

export interface ModelLimit { concurrency?: number; requestsPerMinute?: number }
/** Profile limits complement the shared global permit pool. No timers remain after abort. */
export class ModelGateway {
  private active = new Map<string, number>();
  private starts = new Map<string, number[]>();
  constructor(private limits: Record<string, ModelLimit> = {},private globalLimit=3) {
    for(const value of [globalLimit,...Object.values(limits).flatMap(limit=>[limit.concurrency,limit.requestsPerMinute]).filter((value):value is number=>value!==undefined)])if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid model limit');
  }
  async acquire(id: string, signal: AbortSignal): Promise<() => void> {
    const limit = this.limits[id] ?? {};
    while (true) {
      signal.throwIfAborted();
      const starts = (this.starts.get(id) ?? []).filter(time => time > Date.now() - 60000);
      this.starts.set(id, starts);
      if ([...this.active.values()].reduce((sum,value)=>sum+value,0)<this.globalLimit && (this.active.get(id) ?? 0) < (limit.concurrency ?? Infinity) && starts.length < (limit.requestsPerMinute ?? Infinity)) {
        this.active.set(id, (this.active.get(id) ?? 0) + 1); starts.push(Date.now());
        let released = false;
        return () => { if (!released) { released = true; this.active.set(id, this.active.get(id)! - 1); } };
      }
      await delay(50, undefined, { signal });
    }
  }
}
