import { AsyncLocalStorage } from "node:async_hooks";

export type RequestTimingValue = string | number | boolean;
export type RequestTimingFieldValue = RequestTimingValue;

export interface RequestTimingStore {
  readonly startedAtMs: number;
  fields: Record<string, RequestTimingValue>;
}

const requestTimingStorage = new AsyncLocalStorage<RequestTimingStore>();

export function createRequestTimingStore(): RequestTimingStore {
  return {
    startedAtMs: Date.now(),
    fields: {},
  };
}

export function runWithRequestTimingStore<T>(store: RequestTimingStore, fn: () => T): T {
  return requestTimingStorage.run(store, fn);
}

export function runWithRequestTiming<T>(store: RequestTimingStore, fn: () => T): T {
  return runWithRequestTimingStore(store, fn);
}

export function currentRequestTimingStore(): RequestTimingStore | null {
  return requestTimingStorage.getStore() ?? null;
}

export function setRequestTimingField(key: string, value: RequestTimingValue | null | undefined): void {
  if (!key || value === null || value === undefined) return;
  const store = currentRequestTimingStore();
  if (!store) return;
  store.fields[key] = value;
}

export function setRequestTimingFields(
  values: Record<string, RequestTimingValue | null | undefined>
): void {
  for (const [key, value] of Object.entries(values)) {
    setRequestTimingField(key, value);
  }
}

export function elapsedRequestTimingMs(): number | null {
  const store = currentRequestTimingStore();
  if (!store) return null;
  return Date.now() - store.startedAtMs;
}
