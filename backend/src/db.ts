import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import { encrypt, decrypt } from './encryption.js';
import { emitRowEvent, hasRowSubscribers, anyRowSubscribers } from './dataTableEvents.js';

let db: Database<sqlite3.Database, sqlite3.Statement>;

export async function initDatabase() {
  // LF_DB_PATH lets a container/host point the SQLite file (+ WAL/-shm + binaries) at a
  // persistent volume. Defaults to ./database.sqlite next to the process cwd.
  const dbPath = process.env.LF_DB_PATH
    ? path.resolve(process.env.LF_DB_PATH)
    : path.resolve(process.cwd(), 'database.sqlite');

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

  // Binary store: bytes that must NOT live inline in the execution JSON (which is persisted
  // and feeds the agent/MCP surface). Node outputs carry a lightweight reference instead.
  // `execution_id` is nullable (ad-hoc runs have no persisted execution) and intentionally
  // has NO foreign key — cleanup is explicit in pruneOldExecutions + an orphan TTL sweep.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS binaries (
      id TEXT PRIMARY KEY,
      execution_id TEXT,
      file_name TEXT,
      mime_type TEXT,
      size INTEGER NOT NULL,
      data BLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_binaries_execution ON binaries(execution_id)');

  // Vector store (RAG): persiste las colecciones de js-vector-store como "ficheros" (<col>.bin /
  // <col>.json) dentro del propio SQLite de LibreFlow (backup de un-solo-fichero intacto).
  // owner_id '' = single-tenant/sin dueño; cada fila es un fichero de una colección de un dueño.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS vector_store (
      owner_id TEXT NOT NULL DEFAULT '',
      collection TEXT NOT NULL,
      filename TEXT NOT NULL,
      data BLOB NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_id, filename)
    );
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_vector_store_col ON vector_store(owner_id, collection)');

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

  // Usuarios (auth multi-usuario). `owner_id` en los recursos referencia users.id.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Propiedad de recursos. Nullable a propósito: el enforcement de aislamiento llega en una
  // fase posterior; por ahora los recursos sin dueño se barren al admin bootstrap.
  await addColumnIfMissing('workflows', 'owner_id', 'TEXT');
  await addColumnIfMissing('credentials', 'owner_id', 'TEXT');
  await addColumnIfMissing('data_tables', 'owner_id', 'TEXT');
  await addColumnIfMissing('mcp_servers', 'owner_id', 'TEXT');

  // Data-table state engine: optional unique key column on the table + per-row derived
  // key, enabling atomic upsert/increment and idempotency. NULL row_keys stay distinct
  // in SQLite unique indexes, so non-keyed tables are unaffected.
  await addColumnIfMissing('data_tables', 'key_column', 'TEXT');
  await addColumnIfMissing('data_table_rows', 'row_key', 'TEXT');

  // Suspended workflow runs awaiting an external resume (the `wait` node). `state` holds
  // the workflow snapshot + prior node results + initial payload to continue from.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pending_resumes (
      token TEXT PRIMARY KEY,
      workflow_id TEXT,
      execution_id TEXT,
      wait_node_id TEXT,
      state TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    );
  `);

  // Indexes for the hot filter/sort columns (avoid full table scans as data grows).
  await db.exec('CREATE INDEX IF NOT EXISTS idx_executions_wf ON executions(workflow_id, executed_at)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_versions_wf ON workflow_versions(workflow_id, version)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_rows_table ON data_table_rows(table_id)');
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_rows_key ON data_table_rows(table_id, row_key)');

  await bootstrapAdmin();

  console.log(`[LibreFlow Database] SQLite initialized at: ${dbPath}`);
}

/**
 * Crea el usuario admin inicial desde el entorno (LF_ADMIN_EMAIL / LF_ADMIN_PASSWORD) si no
 * existe, y barre los recursos sin dueño hacia él. Idempotente: re-asigna cualquier NULL en
 * cada arranque (cubre recursos creados antes del enforcement). No hace nada sin las env vars.
 */
async function bootstrapAdmin(): Promise<void> {
  const email = process.env.LF_ADMIN_EMAIL;
  const password = process.env.LF_ADMIN_PASSWORD;
  if (!email || !password) return;

  let admin = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (!admin) {
    const { hashPassword } = await import('./password.js');
    const id = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    await db.run(
      'INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [id, email, hashPassword(password), 'admin']
    );
    admin = { id };
    console.log(`[LibreFlow Auth] Admin bootstrap creado: ${email}`);
  }

  // Barre recursos huérfanos (owner_id IS NULL) al admin.
  for (const table of ['workflows', 'credentials', 'data_tables', 'mcp_servers']) {
    await db.run(`UPDATE ${table} SET owner_id = ? WHERE owner_id IS NULL`, [admin.id]);
  }
}

// --- USERS (auth multi-usuario) ---

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  created_at?: string;
  updated_at?: string;
}

/** Crea un usuario. Lanza si el email ya existe (UNIQUE). */
export async function createUser(email: string, passwordHash: string, role: 'user' | 'admin' = 'user'): Promise<UserRecord> {
  const id = `user-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  try {
    await db.run('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)', [id, email, passwordHash, role]);
  } catch (err: any) {
    if (/UNIQUE constraint/i.test(err?.message || '')) throw new Error(`Ya existe un usuario con el email "${email}".`);
    throw err;
  }
  return { id, email, password_hash: passwordHash, role };
}

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  return (await db.get('SELECT * FROM users WHERE email = ?', [email])) || null;
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  return (await db.get('SELECT * FROM users WHERE id = ?', [id])) || null;
}

/** Lista de usuarios SIN el hash de contraseña (para la gestión por admin). */
export async function listUsers(): Promise<Omit<UserRecord, 'password_hash'>[]> {
  return db.all('SELECT id, email, role, created_at, updated_at FROM users ORDER BY created_at ASC');
}

export async function countUsers(): Promise<number> {
  const r = await db.get('SELECT COUNT(*) as c FROM users');
  return r?.c ?? 0;
}

/** Nº de usuarios con rol admin (para no quedarnos sin ningún admin al borrar/degradar). */
export async function countAdmins(): Promise<number> {
  const r = await db.get("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
  return r?.c ?? 0;
}

export async function deleteUser(id: string): Promise<void> {
  await db.run('DELETE FROM users WHERE id = ?', [id]);
}

/** Cambia la contraseña (hash ya derivado por el llamante). */
export async function updateUserPassword(id: string, passwordHash: string): Promise<void> {
  await db.run('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [passwordHash, id]);
}

// --- OWNERSHIP (auth multi-usuario, enforcement F2) ---

/**
 * Decide si un solicitante puede acceder a un recurso según su dueño o su rol admin.
 * Función pura (contrato `assert-ownership`): admin siempre; mismo dueño sí; dueño distinto
 * o recurso huérfano para no-admin, no. La capa de ruta traduce `false` a 404 (no 403).
 */
export function assertOwnership(resourceOwnerId: string | null | undefined, requesterId: string | null | undefined, requesterIsAdmin: boolean): boolean {
  if (requesterIsAdmin) return true;
  if (!resourceOwnerId) return false;
  return resourceOwnerId === requesterId;
}

/** Devuelve el `owner_id` de un recurso (o null si no existe / sin dueño). Tabla en allowlist. */
export async function getOwnerOf(table: 'workflows' | 'credentials' | 'data_tables' | 'mcp_servers', id: string): Promise<string | null> {
  const row = await db.get(`SELECT owner_id FROM ${table} WHERE id = ?`, [id]);
  return row ? (row.owner_id ?? null) : null;
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
  return db.all('SELECT id, name, description, active, onErrorWorkflowId, owner_id, created_at, updated_at FROM workflows ORDER BY updated_at DESC');
}

/** Todos los flujos con su grafo (nodes/connections parseados). Para validación en lote. */
export async function getAllWorkflowsWithGraph() {
  const list = await db.all('SELECT id, name, nodes, connections, owner_id FROM workflows ORDER BY updated_at DESC');
  return list.map(w => ({
    id: w.id,
    name: w.name,
    nodes: JSON.parse(w.nodes),
    connections: JSON.parse(w.connections),
    owner_id: w.owner_id ?? null,
  }));
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

export async function saveWorkflow(id: string, name: string, nodes: any, connections: any, onErrorWorkflowId?: string, description?: string | null, ownerId?: string | null) {
  const nodesStr = JSON.stringify(nodes);
  const connectionsStr = JSON.stringify(connections);
  // undefined => keep the existing description (COALESCE); null/'' => clear it.
  const desc = description === undefined ? null : description;

  // Persist the workflow and its version atomically — never leave one without the other.
  await db.run('BEGIN');
  try {
    const existing = await db.get('SELECT id FROM workflows WHERE id = ?', [id]);
    if (existing) {
      // UPDATE no toca owner_id: el dueño se fija en la creación y no cambia al editar.
      await db.run(
        'UPDATE workflows SET name = ?, nodes = ?, connections = ?, onErrorWorkflowId = ?, description = COALESCE(?, description), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [name, nodesStr, connectionsStr, onErrorWorkflowId || null, desc, id]
      );
    } else {
      await db.run(
        'INSERT INTO workflows (id, name, nodes, connections, onErrorWorkflowId, description, active, owner_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
        [id, name, nodesStr, connectionsStr, onErrorWorkflowId || null, desc, ownerId || null]
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
  // Drop binaries whose execution was pruned, plus orphans from ad-hoc runs (no execution)
  // older than an hour. Keeps the blob store from growing unbounded.
  await db.run(
    `DELETE FROM binaries
       WHERE (execution_id IS NOT NULL AND execution_id NOT IN (SELECT id FROM executions))
          OR (execution_id IS NULL AND created_at < datetime('now', '-1 hour'))`
  );
}

// ----- Binary store -----

export async function saveBinary(
  id: string,
  executionId: string | null,
  fileName: string | null,
  mimeType: string | null,
  data: Buffer
): Promise<void> {
  await db.run(
    'INSERT INTO binaries (id, execution_id, file_name, mime_type, size, data) VALUES (?, ?, ?, ?, ?, ?)',
    [id, executionId, fileName, mimeType, data.length, data]
  );
}

/** Full binary incl. bytes (Buffer). Returns null if not found. */
export async function getBinary(id: string): Promise<{ id: string; file_name: string | null; mime_type: string | null; size: number; data: Buffer } | null> {
  const row = await db.get('SELECT id, file_name, mime_type, size, data FROM binaries WHERE id = ?', [id]);
  return row || null;
}

// --- VECTOR STORE (RAG) ---
// Las colecciones de js-vector-store se guardan como "ficheros" (<col>.bin/<col>.json) por dueño.

/** Lee los ficheros pedidos de un dueño (para hidratar el MemoryStorageAdapter). */
export async function getVectorFiles(ownerId: string | null, filenames: string[]): Promise<{ filename: string; data: Buffer }[]> {
  if (!filenames.length) return [];
  const ph = filenames.map(() => '?').join(',');
  return db.all(
    `SELECT filename, data FROM vector_store WHERE owner_id = ? AND filename IN (${ph})`,
    [ownerId || '', ...filenames]
  );
}

/** Inserta/actualiza un fichero de una colección (al persistir tras index). */
export async function upsertVectorFile(ownerId: string | null, collection: string, filename: string, data: Buffer): Promise<void> {
  await db.run(
    `INSERT INTO vector_store (owner_id, collection, filename, data, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(owner_id, filename) DO UPDATE SET data = excluded.data, collection = excluded.collection, updated_at = CURRENT_TIMESTAMP`,
    [ownerId || '', collection, filename, data]
  );
}

/** Borra una colección entera de un dueño. */
export async function deleteVectorCollection(ownerId: string | null, collection: string): Promise<void> {
  await db.run('DELETE FROM vector_store WHERE owner_id = ? AND collection = ?', [ownerId || '', collection]);
}

/** Lista las colecciones de un dueño (nombre + nº de ficheros + última actualización). */
export async function listVectorCollections(ownerId: string | null): Promise<{ collection: string; files: number; updated_at: string }[]> {
  return db.all(
    `SELECT collection, COUNT(*) as files, MAX(updated_at) as updated_at
     FROM vector_store WHERE owner_id = ? GROUP BY collection ORDER BY collection ASC`,
    [ownerId || '']
  );
}

export async function getExecutions(workflowId: string) {
  return db.all('SELECT id, status, executed_at FROM executions WHERE workflow_id = ? ORDER BY executed_at DESC LIMIT 50', [workflowId]);
}

export async function getAllExecutions() {
  return db.all(`
    SELECT e.id, e.status, e.executed_at, w.name as workflow_name, w.id as workflow_id, w.owner_id as owner_id
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
  return db.all('SELECT id, name, type, owner_id, created_at, updated_at FROM credentials ORDER BY updated_at DESC');
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

export async function saveCredential(id: string, name: string, type: string, rawData: any, ownerId?: string | null) {
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
      'INSERT INTO credentials (id, name, type, data, owner_id) VALUES (?, ?, ?, ?, ?)',
      [id, name, type, encryptedData, ownerId || null]
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

export async function saveDataTable(id: string, name: string, columns: any[], keyColumn?: string | null, ownerId?: string | null) {
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
      'INSERT INTO data_tables (id, name, columns, key_column, owner_id) VALUES (?, ?, ?, ?, ?)',
      [id, name, colsStr, key, ownerId || null]
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
 * Inserts many rows in a single transaction (all-or-nothing). If any row fails (e.g. a
 * duplicate key on a keyed table) the whole batch rolls back, so callers never get a
 * partial insert. Events are emitted only after a successful commit.
 */
export async function addDataTableRows(tableId: string, rowsData: Record<string, any>[]) {
  const keyColumn = await getTableKeyColumn(tableId);
  const inserted: { id: string; data: Record<string, any> }[] = [];
  await db.run('BEGIN');
  try {
    for (const data of rowsData || []) {
      const rowId = `row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      await db.run(
        'INSERT INTO data_table_rows (id, table_id, row_key, data) VALUES (?, ?, ?, ?)',
        [rowId, tableId, computeRowKey(keyColumn, data), JSON.stringify(data)]
      );
      inserted.push({ id: rowId, data });
    }
    await db.run('COMMIT');
  } catch (err: any) {
    await db.run('ROLLBACK');
    if (/UNIQUE constraint/i.test(err?.message || '')) {
      throw new Error('Duplicate key in batch — no rows were inserted (the whole batch was rolled back).');
    }
    throw err;
  }
  for (const r of inserted) emitRowEvent(tableId, r.id, 'insert', r.data);
  return inserted.map(r => r.id);
}

export interface BatchOp {
  op: 'append' | 'update' | 'delete' | 'upsert' | 'increment';
  rowId?: string;
  key?: string;
  data?: Record<string, any>;
  field?: string;
  amount?: number;
}

/**
 * Aplica una secuencia de operaciones de escritura mixtas (append/update/delete/upsert/
 * increment) en UNA sola transacción (todo-o-nada). Si cualquier op falla, se hace ROLLBACK
 * completo y no se aplica ninguna — esta es la unidad transaccional "una transacción = un
 * nodo" (no hay transacciones entre nodos en el motor stateless). Los eventos reactivos se
 * emiten solo tras un COMMIT correcto.
 */
type BatchRowEvent = { id: string; type: 'insert' | 'update'; data: any };
type BatchOpOutcome = { event: BatchRowEvent | null; result: { op: string; id?: string } };
const newBatchRowId = () => `row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

async function batchAppendOp(tableId: string, keyColumn: string | null, o: BatchOp): Promise<BatchOpOutcome> {
  const data = o.data || {};
  const rowId = newBatchRowId();
  await db.run(
    'INSERT INTO data_table_rows (id, table_id, row_key, data) VALUES (?, ?, ?, ?)',
    [rowId, tableId, computeRowKey(keyColumn, data), JSON.stringify(data)]
  );
  return { event: { id: rowId, type: 'insert', data }, result: { op: 'append', id: rowId } };
}

async function batchUpdateOp(o: BatchOp): Promise<BatchOpOutcome> {
  if (!o.rowId) throw new Error('batch: la operación "update" requiere rowId');
  await db.run(
    'UPDATE data_table_rows SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(o.data || {}), o.rowId]
  );
  return { event: { id: o.rowId, type: 'update', data: o.data || {} }, result: { op: 'update', id: o.rowId } };
}

async function batchDeleteOp(o: BatchOp): Promise<BatchOpOutcome> {
  if (!o.rowId) throw new Error('batch: la operación "delete" requiere rowId');
  await db.run('DELETE FROM data_table_rows WHERE id = ?', [o.rowId]);
  return { event: null, result: { op: 'delete', id: o.rowId } };
}

async function batchUpsertOp(tableId: string, keyColumn: string | null, o: BatchOp): Promise<BatchOpOutcome> {
  if (!keyColumn) throw new Error('batch: "upsert" requiere que la tabla tenga columna clave');
  const data = o.data || {};
  const rowKey = computeRowKey(keyColumn, data);
  if (rowKey === null) throw new Error(`batch: fila sin la columna clave "${keyColumn}"`);
  const existed = await db.get('SELECT id FROM data_table_rows WHERE table_id = ? AND row_key = ?', [tableId, rowKey]);
  await db.run(
    `INSERT INTO data_table_rows (id, table_id, row_key, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(table_id, row_key) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
    [newBatchRowId(), tableId, rowKey, JSON.stringify(data)]
  );
  const row = await db.get('SELECT id, data FROM data_table_rows WHERE table_id = ? AND row_key = ?', [tableId, rowKey]);
  return { event: { id: row.id, type: existed ? 'update' : 'insert', data: JSON.parse(row.data) }, result: { op: 'upsert', id: row.id } };
}

async function batchIncrementOp(tableId: string, keyColumn: string | null, o: BatchOp): Promise<BatchOpOutcome> {
  if (!keyColumn) throw new Error('batch: "increment" requiere que la tabla tenga columna clave');
  if (o.key === undefined || o.key === null || o.key === '') throw new Error('batch: "increment" requiere key');
  const field = o.field || 'count';
  if (/[.[\]$]/.test(field)) throw new Error(`batch: el campo de increment debe ser un nombre de primer nivel (got "${field}")`);
  const amount = Number.isFinite(Number(o.amount)) ? Number(o.amount) : 1;
  const rowKey = String(o.key);
  const existed = await db.get('SELECT id FROM data_table_rows WHERE table_id = ? AND row_key = ?', [tableId, rowKey]);
  await db.run(
    `INSERT INTO data_table_rows (id, table_id, row_key, data)
     VALUES (?, ?, ?, json_object(?, ?, ?, ?))
     ON CONFLICT(table_id, row_key) DO UPDATE
     SET data = json_set(data, '$.' || ?, COALESCE(json_extract(data, '$.' || ?), 0) + ?),
         updated_at = CURRENT_TIMESTAMP`,
    [newBatchRowId(), tableId, rowKey, keyColumn, o.key, field, amount, field, field, amount]
  );
  const row = await db.get('SELECT id, data FROM data_table_rows WHERE table_id = ? AND row_key = ?', [tableId, rowKey]);
  return { event: { id: row.id, type: existed ? 'update' : 'insert', data: JSON.parse(row.data) }, result: { op: 'increment', id: row.id } };
}

/** Aplica UNA op del batch (dentro de la transacción). Lanza en op no soportada. */
async function applyBatchOp(tableId: string, keyColumn: string | null, o: BatchOp): Promise<BatchOpOutcome> {
  switch (o?.op) {
    case 'append': return batchAppendOp(tableId, keyColumn, o);
    case 'update': return batchUpdateOp(o);
    case 'delete': return batchDeleteOp(o);
    case 'upsert': return batchUpsertOp(tableId, keyColumn, o);
    case 'increment': return batchIncrementOp(tableId, keyColumn, o);
    default: throw new Error(`batch: operación no soportada "${o?.op}"`);
  }
}

export async function batchDataTableRows(tableId: string, ops: BatchOp[]) {
  const keyColumn = await getTableKeyColumn(tableId);
  const events: BatchRowEvent[] = [];
  const results: { op: string; id?: string }[] = [];

  await db.run('BEGIN');
  try {
    for (const o of ops || []) {
      const { event, result } = await applyBatchOp(tableId, keyColumn, o);
      if (event) events.push(event);
      results.push(result);
    }
    await db.run('COMMIT');
  } catch (err: any) {
    await db.run('ROLLBACK');
    if (/UNIQUE constraint/i.test(err?.message || '')) {
      throw new Error('batch: clave duplicada — no se aplicó ninguna operación (rollback completo).');
    }
    throw err;
  }

  // Eventos SOLO tras commit (la suscripción no ve cambios a medio aplicar).
  for (const e of events) emitRowEvent(tableId, e.id, e.type, e.data);
  return results;
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
// Equality/membership compare as TEXT so string fields that look numeric (e.g. a zip "01234")
// and real numbers both match; ordering operators compare numerically.
const queryTextVal = (v: any) => (v === true || v === 'true') ? '1' : (v === false || v === 'false') ? '0' : String(v);

/** Cláusula SQL (+params) de UN filtro de query, o null si se omite (sin columna / `in` vacío). */
function buildFilterClause(f: QueryFilter): { clause: string; params: any[] } | null {
  if (!f || !f.column) return null;
  const op = String(f.op || 'eq');
  if (op === 'contains') {
    return { clause: ` AND CAST(json_extract(data, '$.' || ?) AS TEXT) LIKE ?`, params: [f.column, `%${f.value}%`] };
  }
  if (op === 'in') {
    const vals = (Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',').map(s => s.trim()))
      .filter((v: any) => String(v) !== '');
    if (vals.length === 0) return null;
    return {
      clause: ` AND CAST(json_extract(data, '$.' || ?) AS TEXT) IN (${vals.map(() => '?').join(',')})`,
      params: [f.column, ...vals.map(queryTextVal)],
    };
  }
  if (op === 'eq' || op === 'ne') {
    return { clause: ` AND CAST(json_extract(data, '$.' || ?) AS TEXT) ${QUERY_OPS[op]} ?`, params: [f.column, queryTextVal(f.value)] };
  }
  return { clause: ` AND json_extract(data, '$.' || ?) ${QUERY_OPS[op] || '='} ?`, params: [f.column, coerceQueryValue(f.value)] };
}

export async function queryDataTableRows(tableId: string, filters: QueryFilter[] = [], options: QueryOptions = {}) {
  let sql = 'SELECT * FROM data_table_rows WHERE table_id = ?';
  const args: any[] = [tableId];

  for (const f of filters || []) {
    const c = buildFilterClause(f);
    if (!c) continue;
    sql += c.clause;
    args.push(...c.params);
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

// --- PENDING RESUMES (suspended `wait` runs) ---
export async function savePendingResume(
  token: string, workflowId: string | null, executionId: string,
  waitNodeId: string, state: any, expiresAt?: string | null
) {
  await db.run(
    'INSERT OR REPLACE INTO pending_resumes (token, workflow_id, execution_id, wait_node_id, state, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [token, workflowId, executionId, waitNodeId, JSON.stringify(state), expiresAt || null]
  );
}

export async function getPendingResume(token: string) {
  const row = await db.get('SELECT * FROM pending_resumes WHERE token = ?', [token]);
  if (row) row.state = JSON.parse(row.state);
  return row;
}

export async function deletePendingResume(token: string) {
  await db.run('DELETE FROM pending_resumes WHERE token = ?', [token]);
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
  exposeSystemTools: boolean,
  ownerId?: string | null
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
      'INSERT INTO mcp_servers (id, name, workflow_ids, token, require_auth, expose_system_tools, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, idsStr, token, ra, est, ownerId || null]
    );
  }
}

export async function deleteMcpServer(id: string) {
  await db.run('DELETE FROM mcp_servers WHERE id = ?', [id]);
}
