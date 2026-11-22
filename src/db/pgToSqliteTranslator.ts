import crypto from 'node:crypto';
import { getTableName, is, SQL, Table } from 'drizzle-orm';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema.ts';

export type SqliteParamValue = string | number | bigint | Uint8Array | null;

export interface TranslatedSqliteQuery {
  sql: string;
  params: SqliteParamValue[];
}

interface ColumnDefaultSpec {
  kind: 'uuid' | 'now' | 'literal' | 'null';
  literalSql?: string;
}

interface TableSchemaMeta {
  tableName: string;
  createTableSql: string;
  indexSqls: string[];
  columns: Array<{ name: string; alterDefinition: string }>;
  defaultsByCol: Map<string, ColumnDefaultSpec>;
}

const UUID_SQLITE_DEFAULT =
  "(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))))";

const NOW_SQLITE_DEFAULT = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

// Boolean DB columns across schema.ts + known boolean SQL expression aliases
const KNOWN_BOOLEAN_IDENTIFIERS = new Set<string>([
  'hasBotToken',
  'hasWebhookSecret',
  'signatureVerified',
]);

let cachedSchemaMeta: TableSchemaMeta[] | null = null;
let cachedDefaultsByTable: Map<string, Map<string, ColumnDefaultSpec>> | null = null;
let cachedBooleanCols: Set<string> | null = null;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function escapeSqliteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function getColumnDefaultSpec(col: PgColumn): ColumnDefaultSpec {
  if (!col.hasDefault) {
    return { kind: 'null', literalSql: 'NULL' };
  }

  const def = col.default;
  if (is(def, SQL)) {
    const raw = def.queryChunks
      .map((chunk) => {
        if (chunk && typeof chunk === 'object' && 'value' in chunk && Array.isArray((chunk as { value?: unknown }).value)) {
          return ((chunk as { value: string[] }).value).join('');
        }
        return '';
      })
      .join('')
      .trim();

    if (raw.includes('gen_random_uuid')) {
      return { kind: 'uuid', literalSql: UUID_SQLITE_DEFAULT };
    }
    if (raw.includes('now(')) {
      return { kind: 'now', literalSql: NOW_SQLITE_DEFAULT };
    }
    if (raw.endsWith('::jsonb')) {
      return { kind: 'literal', literalSql: raw.slice(0, -'::jsonb'.length) };
    }
    if (raw) {
      return { kind: 'literal', literalSql: raw };
    }
  }

  if (typeof def === 'boolean') {
    return { kind: 'literal', literalSql: def ? '1' : '0' };
  }
  if (typeof def === 'number') {
    return { kind: 'literal', literalSql: String(def) };
  }
  if (typeof def === 'string') {
    return { kind: 'literal', literalSql: escapeSqliteString(def) };
  }
  if (def !== undefined && def !== null) {
    return { kind: 'literal', literalSql: escapeSqliteString(JSON.stringify(def)) };
  }

  return { kind: 'null', literalSql: 'NULL' };
}

function getSqliteColumnType(col: PgColumn): 'INTEGER' | 'TEXT' {
  if (col.dataType === 'number' || col.dataType === 'boolean') {
    return 'INTEGER';
  }
  return 'TEXT';
}

function ensureSchemaMetadata(): {
  tables: TableSchemaMeta[];
  defaultsByTable: Map<string, Map<string, ColumnDefaultSpec>>;
  booleanCols: Set<string>;
} {
  if (cachedSchemaMeta && cachedDefaultsByTable && cachedBooleanCols) {
    return {
      tables: cachedSchemaMeta,
      defaultsByTable: cachedDefaultsByTable,
      booleanCols: cachedBooleanCols,
    };
  }

  const tables: TableSchemaMeta[] = [];
  const defaultsByTable = new Map<string, Map<string, ColumnDefaultSpec>>();
  const booleanCols = new Set<string>(KNOWN_BOOLEAN_IDENTIFIERS);

  for (const exportVal of Object.values(schema)) {
    if (!is(exportVal, Table)) continue;
    const pgTable = exportVal as PgTable;
    const tableName = getTableName(pgTable);
    const cfg = getTableConfig(pgTable);

    const defaultsByCol = new Map<string, ColumnDefaultSpec>();
    const columnDefs: string[] = [];
    const alterColumns: Array<{ name: string; alterDefinition: string }> = [];

    for (const col of cfg.columns) {
      if (col.dataType === 'boolean') {
        booleanCols.add(col.name);
      }

      const defaultSpec = getColumnDefaultSpec(col);
      defaultsByCol.set(col.name, defaultSpec);

      const parts: string[] = [quoteIdent(col.name), getSqliteColumnType(col)];
      if (col.primary) {
        parts.push('PRIMARY KEY');
      }
      if (col.notNull && !col.primary) {
        parts.push('NOT NULL');
      }
      if (col.hasDefault && defaultSpec.literalSql) {
        parts.push(`DEFAULT ${defaultSpec.literalSql}`);
      }
      if (col.isUnique) {
        parts.push('UNIQUE');
      }

      // Inline FK reference if present
      for (const fk of cfg.foreignKeys) {
        const ref = fk.reference();
        if (ref.columns.length === 1 && ref.columns[0]?.name === col.name && ref.foreignColumns.length === 1) {
          const foreignTable = getTableName(ref.foreignTable);
          const foreignCol = ref.foreignColumns[0]!.name;
          let refClause = `REFERENCES ${quoteIdent(foreignTable)} (${quoteIdent(foreignCol)})`;
          if (fk.onDelete) {
            refClause += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
          }
          if (fk.onUpdate) {
            refClause += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
          }
          parts.push(refClause);
        }
      }

      const colSql = parts.join(' ');
      columnDefs.push(colSql);

      // For ALTER TABLE ADD COLUMN reconciliation, SQLite requires constant defaults (not expression defaults) when NOT NULL
      const alterParts: string[] = [quoteIdent(col.name), getSqliteColumnType(col)];
      if (col.hasDefault && defaultSpec.kind === 'literal' && defaultSpec.literalSql) {
        alterParts.push(`DEFAULT ${defaultSpec.literalSql}`);
      }
      alterColumns.push({ name: col.name, alterDefinition: alterParts.join(' ') });
    }

    // Composite primary keys / unique constraints
    for (const pk of cfg.primaryKeys) {
      const cols = pk.columns.map((c) => quoteIdent(c.name)).join(', ');
      columnDefs.push(`PRIMARY KEY (${cols})`);
    }
    for (const uniq of cfg.uniqueConstraints) {
      const cols = uniq.columns.map((c) => quoteIdent(c.name)).join(', ');
      columnDefs.push(`UNIQUE (${cols})`);
    }

    const createTableSql = `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (\n  ${columnDefs.join(',\n  ')}\n)`;

    const indexSqls: string[] = [];
    for (const idx of cfg.indexes) {
      const idxName = idx.config.name;
      if (!idxName) continue;
      const cols = idx.config.columns
        .map((c) => ('name' in c && typeof c.name === 'string' ? quoteIdent(c.name) : ''))
        .filter(Boolean);
      if (cols.length === 0) continue;
      const uniqueKw = idx.config.unique ? 'UNIQUE ' : '';
      indexSqls.push(
        `CREATE ${uniqueKw}INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${quoteIdent(tableName)} (${cols.join(', ')})`,
      );
    }

    tables.push({
      tableName,
      createTableSql,
      indexSqls,
      columns: alterColumns,
      defaultsByCol,
    });
    defaultsByTable.set(tableName, defaultsByCol);
  }

  cachedSchemaMeta = tables;
  cachedDefaultsByTable = defaultsByTable;
  cachedBooleanCols = booleanCols;

  return { tables, defaultsByTable, booleanCols };
}

export function getSqliteSchemaTables(): TableSchemaMeta[] {
  return ensureSchemaMetadata().tables;
}

export function buildSqliteSchemaStatements(): string[] {
  const { tables } = ensureSchemaMetadata();
  const stmts: string[] = [];
  for (const t of tables) {
    stmts.push(t.createTableSql);
  }
  for (const t of tables) {
    for (const idxSql of t.indexSqls) {
      stmts.push(idxSql);
    }
  }
  return stmts;
}

export function normalizeSqliteParam(value: unknown): SqliteParamValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Rewrites `INSERT INTO "table" ("c1", ...) VALUES (default, $1, ...)` tuples
 * so bare `default` expressions become concrete SQLite default literals/params.
 */
function rewriteInsertDefaultTuples(sqlText: string): string {
  const insertMatch = /^insert\s+into\s+"([^"]+)"\s*\(([^)]+)\)\s*values\s*/i.exec(sqlText);
  if (!insertMatch) {
    return sqlText;
  }

  const tableName = insertMatch[1]!;
  const colNames = insertMatch[2]!
    .split(',')
    .map((part) => part.trim().replace(/^"|"$/g, ''));
  const defaultsMap = ensureSchemaMetadata().defaultsByTable.get(tableName);

  const prefix = sqlText.slice(0, insertMatch[0].length);
  const rest = sqlText.slice(insertMatch[0].length);

  // Parse one or more VALUES (...), (...) tuples safely skipping quotes and nested parens
  let idx = 0;
  const rewrittenTuples: string[] = [];

  while (idx < rest.length) {
    while (idx < rest.length && /\s/.test(rest[idx]!)) idx++;
    if (rest[idx] !== '(') break;

    idx++; // skip '('
    const values: string[] = [];
    let current = '';
    let parenDepth = 0;
    let inSingle = false;
    let inDouble = false;

    while (idx < rest.length) {
      const ch = rest[idx]!;
      const next = rest[idx + 1];

      if (inSingle) {
        current += ch;
        if (ch === "'" && next === "'") {
          current += next;
          idx += 2;
          continue;
        }
        if (ch === "'") inSingle = false;
        idx++;
        continue;
      }

      if (inDouble) {
        current += ch;
        if (ch === '"' && next === '"') {
          current += next;
          idx += 2;
          continue;
        }
        if (ch === '"') inDouble = false;
        idx++;
        continue;
      }

      if (ch === "'") {
        inSingle = true;
        current += ch;
        idx++;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        current += ch;
        idx++;
        continue;
      }

      if (ch === '(') {
        parenDepth++;
        current += ch;
        idx++;
        continue;
      }
      if (ch === ')') {
        if (parenDepth === 0) {
          values.push(current.trim());
          idx++; // consume ')'
          break;
        }
        parenDepth--;
        current += ch;
        idx++;
        continue;
      }
      if (ch === ',' && parenDepth === 0) {
        values.push(current.trim());
        current = '';
        idx++;
        continue;
      }

      current += ch;
      idx++;
    }

    const mappedValues = values.map((expr, colIdx) => {
      if (expr.toLowerCase() !== 'default') {
        return expr;
      }
      const colName = colNames[colIdx];
      const spec = colName ? defaultsMap?.get(colName) : undefined;
      if (!spec || spec.kind === 'null') {
        return 'NULL';
      }
      if (spec.kind === 'uuid') {
        return escapeSqliteString(crypto.randomUUID());
      }
      if (spec.kind === 'now') {
        return escapeSqliteString(new Date().toISOString());
      }
      return spec.literalSql ?? 'NULL';
    });

    rewrittenTuples.push(`(${mappedValues.join(', ')})`);

    // Check if another tuple follows after a comma
    let lookahead = idx;
    while (lookahead < rest.length && /\s/.test(rest[lookahead]!)) lookahead++;
    if (rest[lookahead] === ',') {
      idx = lookahead + 1;
      continue;
    }
    break;
  }

  if (rewrittenTuples.length === 0) {
    return sqlText;
  }

  return `${prefix}${rewrittenTuples.join(', ')}${rest.slice(idx)}`;
}

/**
 * Translates PostgreSQL syntax outside quoted literals into SQLite-compatible SQL.
 */
function translateOutsideQuotes(sqlText: string): string {
  // Rewrite PostgreSQL JSON text extraction operator (`lhs->>'key'`) before stripping casts.
  // Drizzle generates forms like `("webhook_events"."payload"->>'signatureVerified')::boolean`
  const jsonFixed = sqlText.replace(
    /(\(?"?[a-zA-Z0-9_]+"?(?:\."?[a-zA-Z0-9_]+"?)?)->>'([^']+)'(\)?)(?:::boolean|::text|::int)?/g,
    (_m, lhs: string, key: string, closeParen: string) => {
      const cleanLhs = lhs.startsWith('(') && closeParen === ')' ? lhs.slice(1) : lhs;
      return `json_extract(${cleanLhs}, '$.${key}')`;
    },
  );

  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < jsonFixed.length) {
    const ch = jsonFixed[i]!;
    const next = jsonFixed[i + 1];

    if (inSingle) {
      out += ch;
      if (ch === "'" && next === "'") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }

    if (inDouble) {
      out += ch;
      if (ch === '"' && next === '"') {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      i++;
      continue;
    }

    // PostgreSQL parameter $1, $2, ... -> SQLite ?1, ?2, ...
    if (ch === '$' && next && next >= '0' && next <= '9') {
      let j = i + 1;
      while (j < jsonFixed.length && jsonFixed[j]! >= '0' && jsonFixed[j]! <= '9') {
        j++;
      }
      out += `?${jsonFixed.slice(i + 1, j)}`;
      i = j;
      continue;
    }

    // Strip PostgreSQL casts (`::boolean`, `::text`, `::jsonb`, `::"public"."enum"`, etc.)
    if (ch === ':' && next === ':') {
      let j = i + 2;
      while (
        j < jsonFixed.length &&
        /[a-zA-Z0-9_." ]/.test(jsonFixed[j]!) &&
        !(jsonFixed[j] === ' ' && jsonFixed.slice(i + 2, j).trim().length > 0)
      ) {
        j++;
      }
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

export function translatePgQueryToSqlite(
  queryString: string,
  params: unknown[],
): TranslatedSqliteQuery {
  const withDefaults = rewriteInsertDefaultTuples(queryString);
  const sqliteSql = translateOutsideQuotes(withDefaults);
  const sqliteParams = params.map(normalizeSqliteParam);
  return {
    sql: sqliteSql,
    params: sqliteParams,
  };
}

export function decodeSqliteRows(
  columnNames: string[],
  rawRows: unknown[][],
): unknown[][] {
  if (rawRows.length === 0 || columnNames.length === 0) {
    return rawRows;
  }

  const { booleanCols } = ensureSchemaMetadata();
  const booleanIndices: number[] = [];

  for (let idx = 0; idx < columnNames.length; idx++) {
    const colName = columnNames[idx];
    if (
      colName &&
      (booleanCols.has(colName) ||
        /\bis\s+(?:not\s+)?null\b|\bsignatureVerified\b/i.test(colName))
    ) {
      booleanIndices.push(idx);
    }
  }

  if (booleanIndices.length === 0) {
    return rawRows;
  }

  return rawRows.map((row) => {
    const copy = [...row];
    for (const colIdx of booleanIndices) {
      const val = copy[colIdx];
      if (val === 1 || val === '1' || val === true) {
        copy[colIdx] = true;
      } else if (val === 0 || val === '0' || val === false) {
        copy[colIdx] = false;
      }
    }
    return copy;
  });
}
