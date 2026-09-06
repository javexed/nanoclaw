// Observers of performed agent-to-agent routes. An installed module gets
// read-only visibility into each route (e.g. mirroring the exchange into a
// human-visible surface). Inert when nothing registers; a throwing observer
// is isolated so it can never block routing.
import { log } from '../log.js';

export interface A2aRouteInfo {
  fromAgentGroupId: string;
  toAgentGroupId: string;
  content: string;
}
type A2aRouteObserver = (info: A2aRouteInfo) => void;
const a2aRouteObservers: A2aRouteObserver[] = [];
export function registerA2aRouteObserver(fn: A2aRouteObserver): void {
  a2aRouteObservers.push(fn);
}
export function notifyA2aRouteObservers(info: A2aRouteInfo): void {
  for (const fn of a2aRouteObservers) {
    try {
      fn(info);
    } catch (err) {
      log.warn('a2a route observer failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }
}
