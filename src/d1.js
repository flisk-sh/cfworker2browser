// D1 over any SQLite. The database itself is an "adapter" so this file has no SQLite in it:
//   adapter.exec(sql, params) -> { columns: string[], rows: any[][], changes: number, lastRowId: number }
//   adapter.script(sql)       -> runs several statements, returns nothing
// d1-sqljs.js makes an adapter from sql.js (SQLite as WebAssembly). Tests use bun:sqlite.
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const sqlToken = /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*'|"(?:""|[^"])*"|\x60(?:\x60\x60|[^\x60])*\x60|\[[^\]]*\]|[A-Za-z_][\w$]*|\S/g;
const triggerPrefix = /^(?:EXPLAIN (?:QUERY PLAN )?)?CREATE (?:TEMP(?:ORARY)? )?TRIGGER$/;

function countStatements(sql) {
  let count = 0;
  let hasStatement = false;
  let inTrigger = false;
  let afterTriggerSemicolon = false;
  const openingTokens = [];
  for (const [token] of sql.matchAll(sqlToken)) {
    if (token.startsWith('--') || token.startsWith('/*')) continue;

    if (inTrigger) {
      // A trigger ends with END after its last inner statement, even if
      // an expression in that statement also contains a CASE ... END.
      if (afterTriggerSemicolon && token.toUpperCase() === 'END') inTrigger = false;
      afterTriggerSemicolon = token === ';';
    } else if (token === ';') {
      if (hasStatement) count++;
      hasStatement = false;
      openingTokens.length = 0;
    } else {
      hasStatement = true;
      if (openingTokens.length < 6) {
        openingTokens.push(token.toUpperCase());
        inTrigger = triggerPrefix.test(openingTokens.join(' '));
        afterTriggerSemicolon = false;
      }
    }
  }
  return count + Number(hasStatement);
}

function checkParam(v) {
  if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) throw new Error("D1_TYPE_ERROR: Type 'object' not supported for value 'Date'");
  return v;
}

const wrap = (e) => {
  const err = new Error(`D1_ERROR: ${e?.message ?? e}`, { cause: e });
  err.name = 'Error';
  return err;
};

export class D1PreparedStatement {
  constructor(adapter, sql, params) {
    this.a = adapter;
    this.sql = sql;
    this.params = params;
  }

  bind(...values) {
    return new D1PreparedStatement(this.a, this.sql, values.map(checkParam));
  }

  // One run of the statement, as rows and meta. batch() calls this inside a transaction.
  run_() {
    const t = clock();
    let r;
    try {
      r = this.a.exec(this.sql, this.params);
    } catch (e) {
      throw wrap(e);
    }
    const meta = {
      duration: clock() - t,
      changes: r.changes,
      last_row_id: r.lastRowId,
      changed_db: r.changes > 0,
      size_after: 0,
      rows_read: r.rows.length,
      rows_written: r.changes,
    };
    return { r, meta };
  }

  async all() {
    const { r, meta } = this.run_();
    const results = r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
    return { success: true, results, meta };
  }

  async run() {
    return this.all();
  }

  async first(column) {
    const { results } = await this.all();
    const row = results[0] ?? null;
    if (column === undefined || row === null) return row;
    if (!(column in row)) throw new Error(`D1_ERROR: No such column: ${column}`);
    return row[column];
  }

  async raw({ columnNames = false } = {}) {
    const { r } = this.run_();
    return columnNames ? [r.columns, ...r.rows] : r.rows;
  }
}

export class D1Database {
  constructor(adapter) {
    this.a = adapter;
  }

  prepare(sql) {
    return new D1PreparedStatement(this.a, sql, []);
  }

  // Runs all the statements in one transaction; if one fails, none of them stays.
  async batch(statements) {
    this.a.script('BEGIN');
    try {
      const out = [];
      for (const s of statements) {
        const { r, meta } = s.run_();
        out.push({
          success: true,
          results: r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))),
          meta,
        });
      }
      this.a.script('COMMIT');
      return out;
    } catch (e) {
      try {
        this.a.script('ROLLBACK');
      } catch {}
      throw e;
    }
  }

  async exec(sql) {
    const t = clock();
    try {
      this.a.script(sql);
    } catch (e) {
      throw wrap(e);
    }
    return { count: countStatements(sql), duration: clock() - t };
  }

  withSession() {
    return Object.assign(this, { getBookmark: () => null });
  }

  async dump() {
    throw new Error('D1_ERROR: dump() is not supported in cfworker2browser');
  }
}
