// Indexer store — manages configured indexer instances in memory + SQLite.
// Each configured indexer = a definition + user settings (API key, URL, etc.)

import type { Indexer, IndexerCapabilities } from '@torrentstack/types';
import type { DefinitionEntry } from './cardigann/loader.js';

// ─── Indexer instance (runtime) ───────────────────────────────────────────────

export type IndexerInstanceType = 'torznab' | 'newznab' | 'cardigann';

export interface IndexerInstance {
  type:             IndexerInstanceType;
  config:           Indexer;
  definition:       DefinitionEntry | null;
  cookies:          Record<string, string>;
  proxyUrl:         string | undefined;
  flareSolverrUrl?: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class IndexerStore {
  private instances = new Map<string, IndexerInstance>();

  add(inst: IndexerInstance): void {
    this.instances.set(inst.config.id, inst);
  }

  get(id: string): IndexerInstance | undefined {
    return this.instances.get(id);
  }

  getAll(): IndexerInstance[] {
    return [...this.instances.values()];
  }

  getEnabled(): IndexerInstance[] {
    return this.getAll().filter(i => i.config.enabled);
  }

  update(id: string, partial: Partial<Indexer>): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.config = { ...inst.config, ...partial };
  }

  remove(id: string): void {
    this.instances.delete(id);
  }

  setCookies(id: string, cookies: Record<string, string>): void {
    const inst = this.instances.get(id);
    if (inst) inst.cookies = { ...inst.cookies, ...cookies };
  }

  updateStatus(id: string, error: string | null): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    if (error) {
      inst.config.status.failureCount++;
      inst.config.status.mostRecentFailure = new Date().toISOString();
      if (!inst.config.status.initialFailure) {
        inst.config.status.initialFailure = new Date().toISOString();
      }
    } else {
      inst.config.status.failureCount = 0;
      inst.config.status.mostRecentFailure = null;
      inst.config.status.initialFailure    = null;
      inst.config.status.disabledTill      = null;
      inst.config.lastTestedAt             = Date.now();
    }
  }

  get count(): number { return this.instances.size; }
}
