import { AsyncLocalStorage } from "node:async_hooks";

export type RequestTimingValue = string | number | boolean;

export interface RequestTimingStore {
  fields: Record<string, RequestTimingValue>;
}

const storage = new AsyncLocalStorage<RequestTimingStore>();

export function createRequestTimingStore(): RequestTimingStore {
  return { fields: {} };
}

export function runWithRequestTimingStore<T>(store: RequestTimingStore, fn: () => T): T {
  return storage.run(store, fn);
}

function currentStore(): RequestTimingStore | null {
  return storage.getStore() ?? null;
}

export function setRequestTimingField(key: string, value: RequestTimingValue | null | undefined): void {
  if (!key || value === null || value === undefined) return;
  const store = currentStore();
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

