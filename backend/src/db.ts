import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import { encrypt, decrypt } from './encryption.js';
import { emitRowEvent, hasRowSubscribers, anyRowSubscribers } from './dataTableEvents.js';

let db: Database<sqlite3.Database, sqlite3.Statement>;

export async function initDatabase() {
  const dbPath = path.resolve(process.cwd(), 'database.sqlite');
  
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Enforce foreign keys so ON DELETE CASCADE actually runs (off by default in SQLite).
  await db.exec('PRAGMA foreign_keys = ON');
  // Wait for locks instead of failing with SQLITE_BUSY — matters now that data-table
  // state ops (upsert/increment) can be written concurrently by multiple flows.
  await db.exec('PRAGMA busy_timeout = 5000');
  // WAL lets readers proceed during a write and keeps write locks brief, sharply
  // reducing lock contention for concurrent state writes.
  await db.exec('PRAGMA journal_mode = WAL');

  // Create workflows table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      nodes TEXT NOT NULL,
      connections TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Idempotent column migrations: only swallow the "duplicate column" error, rethrow the rest.
  await addColumnIfMissing('workflows', 'active', 'INTEGER DEFAULT 0');
  await addColumnIfMissing('workflows', 'onErrorWorkflowId', 'TEXT');
  // Human/agent-facing description; surfaced as the MCP tool description for better selection.
  await addColumnIfMissing('workflows', 'description', 'TEXT');

  // Create executions table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      report TEXT NOT NULL,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );
  `);

  // Create credentials table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create workflow_versions table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      name TEXT NOT NULL,
      nodes TEXT NOT NULL,
      connections TEXT NOT NULL,
      onErrorWorkflowId TEXT,
      version INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );
  `);

  // Create data_tables table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS data_tables (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      columns TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create data_table_rows table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS data_table_rows (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (table_id) REFERENCES data_tables(id) ON DELETE CASCADE
    );
  `);

  // Create mcp_servers table: named MCP servers that expose a curated group of
  // workflows as tools, each reachable at its own public URL (/mcp/:id/...).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workflow_ids TEXT NOT NULL,
      token TEXT,
      require_auth INTEGER DEFAULT 1,
      expose_system_tools INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Data-table state engine: optional unique key column on the table + per-row derived
  // key, enabling atomic upsert/increment and idempotency. NULL row_keys stay distinct
  // in SQLite unique indexes, so non-keyed tables are unaffected.
  await addColumnIfMissing('data_tables', 'key_column', 'TEXT');
  await addColumnIfMissing('data_table_rows', 'row_key', 'TEXT');

  // Indexes for the hot filter/sort columns (avoid full table scans as data grows).
  await db.exec('CREATE INDEX IF NOT EXISTS idx_executions_wf ON executions(workflow_id, executed_at)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_versions_wf ON workflow_versions(workflow_id, version)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_rows_table ON data_table_rows(table_id)');
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_rows_key ON data_table_rows(table_id, row_key)');

  console.log(`[LibreFlow Database] SQLite initialized at: ${dbPath}`);
}

/**
 * Adds a column only if it does not already exist, distinguishing the benign
 * "duplicate column" case from real migration failures (which are rethrown).
 */
async function addColumnIfMissing(table: string, column: string, definition: string) {
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err: any) {
    if (!/duplicate column name/i.test(err?.message || '')) {
      throw err;
    }
  }
}

export async function getWorkflows() {
  return db.all('SELECT id, name, description, active, onErrorWorkflowId, created_at, updated_at FROM workflows ORDER BY updated_at DESC');
}

export async function getActiveWorkflows() {
  const list = await db.all('SELECT * FROM workflows WHERE active = 1 ORDER BY id ASC');
  return list.map(workflow => {
    workflow.nodes = JSON.parse(workflow.nodes);
    workflow.connections = JSON.parse(workflow.connections);
    return workflow;
  });
}

export async function setWorkflowActiveState(id: string, active: boolean) {
  const activeVal = active ? 1 : 0;
  await db.run('UPDATE workflows SET active = ? WHERE id = ?', [activeVal, id]);
}

export async function getWorkflowById(id: string) {
  const workflow = await db.get('SELECT * FROM workflows WHERE id = ?', [id]);
  if (workflow) {
    workflow.nodes = JSON.parse(workflow.nodes);
    workflow.connections = JSON.parse(workflow.connections);
  }
  return workflow;
}

/** Fetches multiple workflows by id in one query, preserving the requested order. */
export async function getWorkflowsByIds(ids: string[]) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const list = await db.all(`SELECT * FROM workflows WHERE id IN (${placeholders})`, ids);
  const byId: Record<string, any> = {};
  for (const w of list) {
    w.nodes = JSON.parse(w.nodes);
    w.connections = JSON.parse(w.connections);
    byId[w.id] = w;
  }
  return ids.map(id => byId[id]).filter(Boolean);
}

export async function saveWorkflow(id: string, name: string, nodes: any, connections: any, onErrorWorkflowId?: string, description?: string | null) {
  const nodesStr = JSON.stringify(nodes);
  const connectionsStr = JSON.stringify(connections);
  // undefined => keep the existing description (COALESCE); null/'' => clear it.
  const desc = description === undefined ? null : description;

  // Persist the workflow and its version atomically — never leave one without the other.
  await db.run('BEGIN');
  try {
    const existing = await db.get('SELECT id FROM workflows WHERE id = ?', [id]);
    if (existing) {
      await db.run(
        'UPDATE workflows SET name = ?, nodes = ?, connections = ?, onErrorWorkflowId = ?, description = COALESCE(?, description), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [name, nodesStr, connectionsStr, onErrorWorkflowId || null, desc, id]
      );
    } else {
      await db.run(
        'INSERT INTO workflows (id, name, nodes, connections, onErrorWorkflowId, description, active) VALUES (?, ?, ?, ?, ?, ?, 0)',
        [id, name, nodesStr, connectionsStr, onErrorWorkflowId || null, desc]
      );
    }

    // Save workflow version automatically (same transaction)
    await saveWorkflowVersion(id, name, nodes, connections, onErrorWorkflowId || null);
    await db.run('COMMIT');
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
}

export async function deleteWorkflow(id: string) {
  await db.run('DELETE FROM workflows WHERE id = ?', [id]);
}

export async function saveExecution(id: string, workflowId: string, status: string, report: any) {
  const reportStr = JSON.stringify(report);
  // Upsert so an execution can be persisted as 'running' first and updated on completion.
  await db.run(
    'INSERT OR REPLACE INTO executions (id, workflow_id, status, report) VALUES (?, ?, ?, ?)',
    [id, workflowId, status, reportStr]
  );
}

/**
 * Caps stored executions per workflow to bound unbounded growth. Keeps the most
 * recent `keep` rows and deletes the rest.
 */
export async function pruneOldExecutions(workflowId: string, keep = 200) {
  await db.run(
    `DELETE FROM executions
     WHERE workflow_id = ?
       AND id NOT IN (
         SELECT id FROM executions WHERE workflow_id = ? ORDER BY executed_at DESC LIMIT ?
       )`,
    [workflowId, workflowId, keep]
  );
}

export async function getExecutions(workflowId: string) {
  return db.all('SELECT id, status, executed_at FROM executions WHERE workflow_id = ? ORDER BY executed_at DESC LIMIT 50', [workflowId]);
}

export async function getAllExecutions() {
  return db.all(`
    SELECT e.id, e.status, e.executed_at, w.name as workflow_name, w.id as workflow_id
    FROM executions e
    JOIN workflows w ON e.workflow_id = w.id
    ORDER BY e.executed_at DESC
    LIMIT 100
  `);
}

export async function getExecutionById(id: string) {
  const execution = await db.get('SELECT * FROM executions WHERE id = ?', [id]);
  if (execution) {
    execution.report = JSON.parse(execution.report);
  }
  return execution;
}

export async function getCredentials() {
  return db.all('SELECT id, name, type, created_at, updated_at FROM credentials ORDER BY updated_at DESC');
}

export async function getCredentialById(id: string) {
  const credential = await db.get('SELECT * FROM credentials WHERE id = ?', [id]);
  if (credential) {
    try {
      const decryptedStr = decrypt(credential.data);
      credential.data = JSON.parse(decryptedStr);
    } catch (err: any) {
      console.error(`[Database] Error decrypting credential ${id}:`, err.message);
      credential.data = {};
    }
  }
  return credential;
}

export async function saveCredential(id: string, name: string, type: string, rawData: any) {
  const dataStr = JSON.stringify(rawData);
  const encryptedData = encrypt(dataStr);

  const existing = await db.get('SELECT id FROM credentials WHERE id = ?', [id]);
  if (existing) {
    await db.run(
      'UPDATE credentials SET name = ?, type = ?, data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, type, encryptedData, id]
    );
  } else {
    await db.run(
      'INSERT INTO credentials (id, name, type, data) VALUES (?, ?, ?, ?)',
      [id, name, type, encryptedData]
    );
  }
}

export async function deleteCredential(id: string) {
  await db.run('DELETE FROM credentials WHERE id = ?', [id]);
}

export async function saveWorkflowVersion(
  workflowId: string,
  name: string,
  nodes: any,
  connections: any,
  onErrorWorkflowId?: string | null
): Promise<boolean> {
  const nodesStr = JSON.stringify(nodes);
  const connectionsStr = JSON.stringify(connections);
  const errId = onErrorWorkflowId || null;

  // 1. Get the max version for this workflow
  const row = await db.get('SELECT MAX(version) as maxVer FROM workflow_versions WHERE workflow_id = ?', [workflowId]);
  const maxVer = row && row.maxVer ? Number(row.maxVer) : 0;

  // 2. If a version exists, get its details to compare
  if (maxVer > 0) {
    const lastVersion = await db.get(
      'SELECT name, nodes, connections, onErrorWorkflowId FROM workflow_versions WHERE workflow_id = ? AND version = ?',
      [workflowId, maxVer]
    );
    if (lastVersion) {
      // Compare if everything is exactly the same
      if (
        lastVersion.name === name &&
        lastVersion.nodes === nodesStr &&
        lastVersion.connections === connectionsStr &&
        lastVersion.onErrorWorkflowId === errId
      ) {
        // No changes, skip creating a redundant version
        return false;
      }
    }
  }

  // 3. Insert new version
  const newVer = maxVer + 1;
  const verId = `ver-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  await db.run(
    'INSERT INTO workflow_versions (id, workflow_id, name, nodes, connections, onErrorWorkflowId, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [verId, workflowId, name, nodesStr, connectionsStr, errId, newVer]
  );
  return true;
}

export async function getWorkflowVersions(workflowId: string) {
  return db.all(
    'SELECT id, name, version, created_at FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC',
    [workflowId]
  );
}

export async function getWorkflowVersion(workflowId: string, version: number) {
  const ver = await db.get(
    'SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?',
    [workflowId, version]
  );
  if (ver) {
    ver.nodes = JSON.parse(ver.nodes);
    ver.connections = JSON.parse(ver.connections);
  }
  return ver;
}

export async function restoreWorkflowToVersion(workflowId: string, version: number) {
  const ver = await getWorkflowVersion(workflowId, version);
  if (!ver) {
    throw new Error(`Version ${version} not found for workflow ${workflowId}`);
  }
  await saveWorkflow(workflowId, ver.name, ver.nodes, ver.connections, ver.onErrorWorkflowId);
  return ver;
}

// --- DATA TABLES CRUD METHODS ---
export async function getDataTables() {
  return db.all('SELECT * FROM data_tables ORDER BY name ASC');
}

export async function getDataTableById(id: string) {
  const table = await db.get('SELECT * FROM data_tables WHERE id = ?', [id]);
  if (table) {
    table.columns = JSON.parse(table.columns);
  }
  return table;
}

export async function getDataTableByName(name: string) {
  const table = await db.get('SELECT * FROM data_tables WHERE name = ?', [name]);
  if (table) {
    table.columns = JSON.parse(table.columns);
  }
  return table;
}

export async function saveDataTable(id: string, name: string, columns: any[], keyColumn?: string | null) {
  const colsStr = JSON.stringify(columns);
  const key = keyColumn || null;
  const existing = await db.get('SELECT id FROM data_tables WHERE id = ?', [id]);
  if (existing) {
    await db.run(
      'UPDATE data_tables SET name = ?, columns = ?, key_column = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, colsStr, key, id]
    );
  } else {
    await db.run(
      'INSERT INTO data_tables (id, name, columns, key_column) VALUES (?, ?, ?, ?)',
      [id, name, colsStr, key]
    );
  }
}

/** The unique key value for a row, derived from the table's key column (null = no key). */
function computeRowKey(keyColumn: string | null | undefined, data: Record<string, any>): string | null {
  if (!keyColumn) return null;
  const v = data?.[keyColumn];
  return v === undefined || v === null ? null : String(v);
}

async function getTableKeyColumn(tableId: string): Promise<string | null> {
  const t = await db.get('SELECT key_column FROM data_tables WHERE id = ?', [tableId]);
  if (!t) throw new Error(`Data table not found: ${tableId}`);
  return t.key_column || null;
}

export async function deleteDataTable(id: string) {
  await db.run('DELETE FROM data_tables WHERE id = ?', [id]);
}

export async function getDataTableRows(tableId: string, limit = 1000, offset = 0) {
  const safeLimit = Math.min(5000, Math.max(1, Number(limit) || 1000));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const rows = await db.all(
    'SELECT * FROM data_table_rows WHERE table_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    [tableId, safeLimit, safeOffset]
  );
  return rows.map(r => ({
    id: r.id,
    table_id: r.table_id,
    data: JSON.parse(r.data),
    created_at: r.created_at,
    updated_at: r.updated_at
  }));
}

export async function countDataTableRows(tableId: string): Promise<number> {
  const r = await db.get('SELECT COUNT(*) as c FROM data_table_rows WHERE table_id = ?', [tableId]);
  return r?.c ?? 0;
}

export async function addDataTableRow(tableId: string, rowId: string, data: Record<string, any>) {
  const keyColumn = await getTableKeyColumn(tableId);
  const rowKey = computeRowKey(keyColumn, data);
  try {
    await db.run(
      'INSERT INTO data_table_rows (id, table_id, row_key, data) VALUES (?, ?, ?, ?)',
      [rowId, tableId, rowKey, JSON.stringify(data)]
    );
  } catch (err: any) {
    if (/UNIQUE constraint/i.test(err?.message || '')) {
      throw new Error(`A row with key "${rowKey}" already exists in this table (use upsert).`);
    }
    throw err;
  }
  emitRowEvent(tableId, rowId, 'insert', data);
}

/**
 * Atomically inserts or updates a row by the table's key column (ON CONFLICT). Requires
 * the table to declare a key column. This is the idempotency / state-write primitive.
 */
export async function upsertDataTableRow(tableId: string, data: Record<string, any>) {
  const keyColumn = await getTableKeyColumn(tableId);
  if (!keyColumn) throw new Error('Upsert requires the data table to have a key column.');
  const rowKey = computeRowKey(keyColumn, data);
  if (rowKey === null) throw new Error(`Row is missing the key column "${keyColumn}".`);
  // The existence check only feeds the insert/update event — skip it when nobody subscribes.
  const existed = hasRowSubscribers(tableId)
    ? await db.get('SELECT id FROM data_table_rows WHERE table_id = ? AND row_key = ?', [tableId, rowKey])
    : null;
  const id = `row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  await db.run(
    `INSERT INTO data_table_rows (id, table_id, row_key, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(table_id, row_key) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
    [id, tableId, rowKey, JSON.stringify(data)]
  );
  const row = await db.get('SELECT * FROM data_table_rows WHERE table_id = ? AND row_key = ?', [tableId, rowKey]);
  if (!row) throw new Error('Upserted row not found (concurrent delete?).');
  const parsed = JSON.parse(row.data);
  emitRowEvent(tableId, row.id, existed ? 'update' : 'insert', parsed);
  return { id: row.id, table_id: tableId, key: rowKey, data: parsed };
}

/**
 * Atomically increments a numeric field of the row identified by `key`, creating the row
 * if absent. Concurrency-safe: the read-modify-write happens in a single SQL statement.
 */
export async function incrementDataTableRow(tableId: string, key: string, field: string, amount = 1) {
  const keyColumn = await getTableKeyColumn(tableId);
  if (!keyColumn) throw new Error('Increment requires the data table to have a key column.');
  // The field must be a top-level key: json_object() stores it literally while json_set()
  // would treat '.'/'['/'$' as a nested path, so a dotted name would split the counter.
  if (/[.[\]$]/.test(field)) throw new Error(`Increment field must be a top-level field name (got "${field}").`);
  const rowKey = String(key);
  const existed = hasRowSubscribers(tableId)
    ? await db.get('SELECT id FROM data_table_rows WHERE table_id = ? AND row_key = ?', [tableId, rowKey])
    : null;
  const id = `row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  await db.run(
    `INSERT INTO data_table_rows (id, table_id, row_key, data)
     VALUES (?, ?, ?, json_object(?, ?, ?, ?))
     ON CONFLICT(table_id, row_key) DO UPDATE
     SET data = json_set(data, '$.' || ?, COALESCE(json_extract(data, '$.' || ?), 0) + ?),
         updated_at = CURRENT_TIMESTAMP`,
    [id, tableId, rowKey, keyColumn, key, field, amount, field, field, amount]
  );
  const row = await db.get('SELECT * FROM data_table_rows WHERE table_id = ? AND row_key = ?', [tableId, rowKey]);
  if (!row) throw new Error('Incremented row not found (concurrent delete?).');
  const parsed = JSON.parse(row.data);
  emitRowEvent(tableId, row.id, existed ? 'update' : 'insert', parsed);
  return { id: row.id, table_id: tableId, key: rowKey, data: parsed };
}

/** Returns the row with the given key, or inserts `defaults` and returns it if absent. */
export async function getOrCreateDataTableRow(tableId: string, key: string, defaults: Record<string, any> = {}) {
  const keyColumn = await getTableKeyColumn(tableId);
  if (!keyColumn) throw new Error('get-or-default requires the data table to have a key column.');
  const rowKey = String(key);
  const existing = await db.get('SELECT * FROM data_table_rows WHERE table_id = ? AND row_key = ?', [tableId, rowKey]);
  if (existing) {
    return { id: existing.id, table_id: tableId, key: rowKey, data: JSON.parse(existing.data), created: false };
  }
  const id = `row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const data = { ...defaults, [keyColumn]: key };
  await db.run(
    `INSERT INTO data_table_rows (id, table_id, row_key, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(table_id, row_key) DO NOTHING`,
    [id, tableId, rowKey, JSON.stringify(data)]
  );
  const row = await db.get('SELECT * FROM data_table_rows WHERE table_id = ? AND row_key = ?', [tableId, rowKey]);
  if (!row) throw new Error('Row not found after get-or-create (concurrent delete?).');
  const parsed = JSON.parse(row.data);
  emitRowEvent(tableId, row.id, 'insert', parsed);
  return { id: row.id, table_id: tableId, key: rowKey, data: parsed, created: true };
}

const QUERY_OPS: Record<string, string> = {
  eq: '=', ne: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=',
};

/** Coerces a filter value so numeric/boolean comparisons against json_extract work. */
function coerceQueryValue(v: any): any {
  if (typeof v === 'string') {
    if (v === 'true') return 1;
    if (v === 'false') return 0;
    if (v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export interface QueryFilter { column: string; op?: string; value?: any }
export interface QueryOptions { sort?: { column: string; dir?: 'asc' | 'desc' }; limit?: number; offset?: number }

/**
 * Queries rows with JSON-field operators (eq/ne/gt/lt/gte/lte/contains/in), optional
 * sort and limit, pushing the work into SQLite (json_extract) instead of loading all
 * rows and filtering in JS. Column names are parameterized (injection-safe).
 */
export async function queryDataTableRows(tableId: string, filters: QueryFilter[] = [], options: QueryOptions = {}) {
  let sql = 'SELECT * FROM data_table_rows WHERE table_id = ?';
  const args: any[] = [tableId];

  // Equality/membership compare as TEXT so string fields that look numeric (e.g. a zip
  // "01234") and real numbers both match; ordering operators compare numerically.
  const textVal = (v: any) => (v === true || v === 'true') ? '1' : (v === false || v === 'false') ? '0' : String(v);
  for (const f of filters || []) {
    if (!f || !f.column) continue;
    const op = String(f.op || 'eq');
    if (op === 'contains') {
      sql += ` AND CAST(json_extract(data, '$.' || ?) AS TEXT) LIKE ?`;
      args.push(f.column, `%${f.value}%`);
    } else if (op === 'in') {
      const vals = (Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',').map(s => s.trim()))
        .filter((v: any) => String(v) !== '');
      if (vals.length === 0) continue;
      sql += ` AND CAST(json_extract(data, '$.' || ?) AS TEXT) IN (${vals.map(() => '?').join(',')})`;
      args.push(f.column, ...vals.map(textVal));
    } else if (op === 'eq' || op === 'ne') {
      sql += ` AND CAST(json_extract(data, '$.' || ?) AS TEXT) ${QUERY_OPS[op]} ?`;
      args.push(f.column, textVal(f.value));
    } else {
      sql += ` AND json_extract(data, '$.' || ?) ${QUERY_OPS[op] || '='} ?`;
      args.push(f.column, coerceQueryValue(f.value));
    }
  }

  if (options.sort?.column) {
    sql += ` ORDER BY json_extract(data, '$.' || ?) ${options.sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
    args.push(options.sort.column);
  } else {
    sql += ' ORDER BY created_at ASC';
  }

  const limit = Math.min(5000, Math.max(1, Number(options.limit) || 1000));
  const offset = Math.max(0, Number(options.offset) || 0);
  sql += ` LIMIT ${limit} OFFSET ${offset}`;

  const rows = await db.all(sql, args);
  return rows.map(r => ({
    id: r.id,
    table_id: r.table_id,
    data: JSON.parse(r.data),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

export async function updateDataTableRow(rowId: string, data: Record<string, any>) {
  const dataStr = JSON.stringify(data);
  await db.run(
    'UPDATE data_table_rows SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [dataStr, rowId]
  );
  // Only resolve the table_id (extra SELECT) when some table actually has a subscriber.
  if (anyRowSubscribers()) {
    const row = await db.get('SELECT table_id FROM data_table_rows WHERE id = ?', [rowId]);
    if (row) emitRowEvent(row.table_id, rowId, 'update', data);
  }
}

export async function deleteDataTableRow(rowId: string) {
  await db.run('DELETE FROM data_table_rows WHERE id = ?', [rowId]);
}

// --- MCP SERVERS CRUD METHODS ---

/** Normalizes a raw DB row: parses workflow_ids JSON and coerces flags to booleans. */
function hydrateMcpServer(s: any) {
  if (!s) return s;
  let ids: string[] = [];
  try {
    ids = JSON.parse(s.workflow_ids || '[]');
  } catch {
    ids = [];
  }
  return {
    ...s,
    workflow_ids: Array.isArray(ids) ? ids : [],
    require_auth: !!s.require_auth,
    expose_system_tools: !!s.expose_system_tools,
  };
}

export async function getMcpServers() {
  const list = await db.all('SELECT * FROM mcp_servers ORDER BY updated_at DESC');
  return list.map(hydrateMcpServer);
}

export async function getMcpServerById(id: string) {
  const s = await db.get('SELECT * FROM mcp_servers WHERE id = ?', [id]);
  return hydrateMcpServer(s);
}

export async function saveMcpServer(
  id: string,
  name: string,
  workflowIds: string[],
  token: string | null,
  requireAuth: boolean,
  exposeSystemTools: boolean
) {
  const idsStr = JSON.stringify(Array.isArray(workflowIds) ? workflowIds : []);
  const ra = requireAuth ? 1 : 0;
  const est = exposeSystemTools ? 1 : 0;
  const existing = await db.get('SELECT id FROM mcp_servers WHERE id = ?', [id]);
  if (existing) {
    await db.run(
      'UPDATE mcp_servers SET name = ?, workflow_ids = ?, token = ?, require_auth = ?, expose_system_tools = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, idsStr, token, ra, est, id]
    );
  } else {
    await db.run(
      'INSERT INTO mcp_servers (id, name, workflow_ids, token, require_auth, expose_system_tools) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name, idsStr, token, ra, est]
    );
  }
}

export async function deleteMcpServer(id: string) {
  await db.run('DELETE FROM mcp_servers WHERE id = ?', [id]);
}
