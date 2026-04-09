import { Client } from "pg";

type PgClientLike = Client & {
  _connected?: boolean;
  _connecting?: boolean;
  _ending?: boolean;
  connectionParameters?: { database?: string };
};

function isPlaceholderDatabase(client: PgClientLike): boolean {
  return client.connectionParameters?.database === "postgres";
}

function isAlreadyConnected(client: PgClientLike): boolean {
  return Boolean(client._connected || client._connecting || client._ending);
}

function resolveNoopConnect(
  client: Client,
  callback?: ((error: Error | null, client?: Client) => void) | ((error: Error | null) => void)
) {
  if (callback) {
    callback(null, client);
    return;
  }

  return Promise.resolve(client);
}

function resolveNoop(callback?: ((error: Error | null) => void) | undefined) {
  if (callback) {
    callback(null);
    return;
  }

  return Promise.resolve();
}

try {
  const originalConnect = Client.prototype.connect;
  const originalQuery = Client.prototype.query;
  const originalEnd = Client.prototype.end;

  Client.prototype.connect = function patchedConnect(this: PgClientLike, callback?: any) {
    if (isAlreadyConnected(this)) {
      return resolveNoopConnect(this, callback);
    }

    if (isPlaceholderDatabase(this)) {
      this._connected = true;
      return resolveNoopConnect(this, callback);
    }

    return originalConnect.apply(this, arguments as never);
  } as typeof Client.prototype.connect;

  Client.prototype.query = function patchedQuery(
    this: PgClientLike,
    text: unknown,
    values?: unknown,
    callback?: unknown
  ) {
    if (isPlaceholderDatabase(this)) {
      if (typeof text === "string" && text.includes("SELECT 1 FROM pg_database WHERE datname")) {
        return Promise.resolve({ rows: [{ "?column?": 1 }] });
      }

      return Promise.resolve({ rows: [] });
    }

    return originalQuery.apply(this, arguments as never);
  } as typeof Client.prototype.query;

  Client.prototype.end = function patchedEnd(this: PgClientLike) {
    if (isPlaceholderDatabase(this)) {
      this._connected = false;
      return Promise.resolve();
    }

    return originalEnd.apply(this, arguments as never);
  } as typeof Client.prototype.end;
} catch (error) {
  console.error("Patch error", error);
}
