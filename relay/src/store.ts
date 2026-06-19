import Database from "better-sqlite3";
import { join } from "path";

/**
 * A single tunnel's lifecycle record. `closedAt` is null while the tunnel is
 * live; once set the row is "historic".
 */
export interface TunnelRecord {
  id: number;
  subdomain: string;
  clientIp: string | null;
  openedAt: number;
  closedAt: number | null;
  requestCount: number;
  closeReason: string | null;
}

export interface TunnelStore {
  /** Record a freshly-registered tunnel; returns its row id. */
  open(input: { subdomain: string; clientIp: string | null; openedAt: number }): number;
  /** Mark a tunnel closed and persist its final request count. */
  markClosed(
    id: number,
    input: { closedAt: number; requestCount: number; reason?: string }
  ): void;
  /** Most recently closed tunnels, newest first. */
  recentClosed(limit: number): TunnelRecord[];
  /** True when history is durable (file-backed) rather than in-memory only. */
  readonly durable: boolean;
  /** Close the underlying database. */
  dispose(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tunnels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subdomain     TEXT    NOT NULL,
    client_ip     TEXT,
    opened_at     INTEGER NOT NULL,
    closed_at     INTEGER,
    request_count INTEGER NOT NULL DEFAULT 0,
    close_reason  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tunnels_closed_at ON tunnels (closed_at);
`;

function rowToRecord(row: {
  id: number;
  subdomain: string;
  client_ip: string | null;
  opened_at: number;
  closed_at: number | null;
  request_count: number;
  close_reason: string | null;
}): TunnelRecord {
  return {
    id: row.id,
    subdomain: row.subdomain,
    clientIp: row.client_ip,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    requestCount: row.request_count,
    closeReason: row.close_reason,
  };
}

/**
 * Resolve the SQLite path from the environment. An explicit `RAILGATE_DB_PATH`
 * wins; otherwise `RAILGATE_DATA_DIR` (the Railway volume mount) holds the db.
 * Returns null when neither is set so the caller falls back to in-memory.
 */
function resolveDbPath(): string | null {
  if (process.env.RAILGATE_DB_PATH) return process.env.RAILGATE_DB_PATH;
  if (process.env.RAILGATE_DATA_DIR) {
    return join(process.env.RAILGATE_DATA_DIR, "railgate.sqlite");
  }
  return null;
}

/**
 * Open the tunnel history store. Tries the configured file path first; if it
 * can't be opened (no volume mounted, permissions, corruption) it degrades to
 * an in-memory database so the relay always starts. `dbPath` overrides the
 * environment (used by tests).
 */
export function createStore(dbPath?: string): TunnelStore {
  const target = dbPath ?? resolveDbPath() ?? ":memory:";
  let db: Database.Database;
  let durable = target !== ":memory:";

  try {
    db = new Database(target);
  } catch (err) {
    console.warn(
      `[railgate] could not open history db at ${target} (${(err as Error).message}) — using in-memory history`
    );
    db = new Database(":memory:");
    durable = false;
  }

  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  // Rows still marked open belong to a previous process whose control sockets
  // are long gone. Close them so they don't masquerade as active tunnels.
  db.prepare(
    `UPDATE tunnels SET closed_at = ?, close_reason = 'relay restart' WHERE closed_at IS NULL`
  ).run(Date.now());

  const openStmt = db.prepare(
    `INSERT INTO tunnels (subdomain, client_ip, opened_at) VALUES (?, ?, ?)`
  );
  const closeStmt = db.prepare(
    `UPDATE tunnels SET closed_at = ?, request_count = ?, close_reason = ? WHERE id = ?`
  );
  const recentStmt = db.prepare(
    `SELECT id, subdomain, client_ip, opened_at, closed_at, request_count, close_reason
       FROM tunnels
      WHERE closed_at IS NOT NULL
      ORDER BY closed_at DESC
      LIMIT ?`
  );

  // Async socket-close handlers can fire after the relay disposes the store
  // during shutdown; no-op those writes instead of touching a closed db.
  let disposed = false;

  return {
    durable,
    open({ subdomain, clientIp, openedAt }) {
      if (disposed) return -1;
      const info = openStmt.run(subdomain, clientIp, openedAt);
      return Number(info.lastInsertRowid);
    },
    markClosed(id, input) {
      if (disposed || id < 0) return;
      closeStmt.run(input.closedAt, input.requestCount, input.reason ?? null, id);
    },
    recentClosed(limit) {
      if (disposed) return [];
      const rows = recentStmt.all(limit) as Parameters<typeof rowToRecord>[0][];
      return rows.map(rowToRecord);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      db.close();
    },
  };
}
