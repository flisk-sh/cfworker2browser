import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readConfig, parseToml } from '../src/config.js';
import { D1Database } from '../src/d1.js';
import { createWorkerRuntime } from '../src/runtime.js';
import { MemoryKV, MemoryR2 } from '../src/stores.js';
import { startWorker } from '../src/index.js';

const TOML = `
name = "coffee"   # the worker
main = "src/index.ts"
compatibility_date = "2025-01-01"

[vars]
GREETING = "hello"
LIMIT = 5
FLAGS = { beta = true }

[[kv_namespaces]]
binding = "CACHE"
id = "abc"

[[r2_buckets]]
binding = "FILES"
bucket_name = "files"

[[d1_databases]]
binding = "DB"
database_name = "coffee"

[[services]]
binding = "AUTH"
service = "auth"

[triggers]
crons = [
  "*/5 * * * *", # every five minutes
  "0 0 * * *",
]
`;

describe('config', () => {
  test('reads wrangler.toml', () => {
    const c = readConfig(TOML);
    expect(c.name).toBe('coffee');
    expect(c.main).toBe('src/index.ts');
    expect(c.vars).toEqual({ GREETING: 'hello', LIMIT: 5, FLAGS: { beta: true } });
    expect(c.kv_namespaces).toEqual([{ binding: 'CACHE', id: 'abc' }]);
    expect(c.r2_buckets[0].binding).toBe('FILES');
    expect(c.d1_databases[0].database_name).toBe('coffee');
    expect(c.services).toEqual([{ binding: 'AUTH', service: 'auth' }]);
    expect(c.crons).toEqual(['*/5 * * * *', '0 0 * * *']);
  });
  test('reads wrangler.jsonc with comments and trailing commas', () => {
    const c = readConfig('{ // name\n "name": "x", "vars": {"A": "1",}, /* c */ "kv_namespaces": [{"binding":"K"},] }');
    expect(c.name).toBe('x');
    expect(c.vars.A).toBe('1');
    expect(c.kv_namespaces[0].binding).toBe('K');
  });
  test('preserves comma and bracket sequences inside JSONC strings', () => {
    const c = readConfig(String.raw`{
      "vars": {"GREETING": "quoted \"text\",}", "LABELS": ["literal, ]", /* trailing */],},
    }`);
    expect(c.vars).toEqual({ GREETING: 'quoted "text",}', LABELS: ['literal, ]'] });
  });
  test('a "#" inside a string is not a comment, and bad input throws', () => {
    expect(parseToml('a = "x # y"').a).toBe('x # y');
    expect(() => parseToml('a = "open')).toThrow();
    expect(() => parseToml('= 1')).toThrow();
  });
});

describe('KV', () => {
  test('get, put, types, metadata, delete', async () => {
    const kv = new MemoryKV();
    await kv.put('a', '{"n":1}', { metadata: { m: 1 } });
    expect(await kv.get('a')).toBe('{"n":1}');
    expect(await kv.get('a', 'json')).toEqual({ n: 1 });
    expect(await kv.get('a', { type: 'arrayBuffer' })).toBeInstanceOf(ArrayBuffer);
    expect(await new Response(await kv.get('a', 'stream')).text()).toBe('{"n":1}');
    expect(await kv.getWithMetadata('a')).toMatchObject({ value: '{"n":1}', metadata: { m: 1 } });
    expect(await kv.get('missing')).toBeNull();
    expect((await kv.get(['a', 'missing'])).get('missing')).toBeNull();
    await kv.delete('a');
    expect(await kv.get('a')).toBeNull();
    await expect(kv.get('x', 'nope')).rejects.toThrow('Unknown type');
  });
  test('expiry follows the clock, and a TTL under 60 s is refused like the platform does', async () => {
    let t = 1_000_000;
    const kv = new MemoryKV({ now: () => t });
    await kv.put('k', 'v', { expirationTtl: 60 });
    expect(await kv.get('k')).toBe('v');
    t += 61_000;
    expect(await kv.get('k')).toBeNull();
    await expect(kv.put('k', 'v', { expirationTtl: 10 })).rejects.toThrow('at least 60');
  });
  test('list pages with a cursor and filters by prefix', async () => {
    const kv = new MemoryKV();
    for (const k of ['b/1', 'b/2', 'b/3', 'a/1']) await kv.put(k, '1');
    const p1 = await kv.list({ prefix: 'b/', limit: 2 });
    expect(p1.keys.map((k) => k.name)).toEqual(['b/1', 'b/2']);
    expect(p1.list_complete).toBe(false);
    const p2 = await kv.list({ prefix: 'b/', limit: 2, cursor: p1.cursor });
    expect(p2.keys.map((k) => k.name)).toEqual(['b/3']);
    expect(p2.list_complete).toBe(true);
  });
  test('snapshot restores', async () => {
    const a = new MemoryKV();
    await a.put('k', 'v');
    expect(await new MemoryKV({ initial: a.snapshot() }).get('k')).toBe('v');
  });
});

describe('R2', () => {
  test('put, get, head, list, delete', async () => {
    const r2 = new MemoryR2();
    const put = await r2.put('docs/a.txt', 'hello', { httpMetadata: { contentType: 'text/plain' }, customMetadata: { who: 'me' } });
    expect(put.size).toBe(5);
    const o = await r2.get('docs/a.txt');
    expect(await o.text()).toBe('hello');
    expect(o.bodyUsed).toBe(true);
    await expect(o.text()).rejects.toThrow('already been used');
    const h = new Headers();
    (await r2.head('docs/a.txt')).writeHttpMetadata(h);
    expect(h.get('content-type')).toBe('text/plain');
    expect((await r2.head('docs/a.txt')).customMetadata).toEqual({ who: 'me' });
    expect(await r2.get('nope')).toBeNull();
    await r2.put('docs/b.txt', 'x');
    await r2.put('top.txt', 'x');
    const l = await r2.list({ delimiter: '/' });
    expect(l.objects.map((x) => x.key)).toEqual(['top.txt']);
    expect(l.delimitedPrefixes).toEqual(['docs/']);
    await r2.delete(['docs/a.txt', 'docs/b.txt']);
    expect((await r2.list({ prefix: 'docs/' })).objects).toEqual([]);
  });
});

const sqliteAdapter = (db) => ({
  exec(sql, params) {
    const s = db.query(sql);
    const rows = s.values(...params) ?? [];
    const info = db.query('select changes() as c, last_insert_rowid() as r').get();
    return { columns: s.columnNames, rows, changes: rows.length ? 0 : info.c, lastRowId: info.r };
  },
  script: (sql) => db.exec(sql),
});

describe('D1', () => {
  const make = async () => {
    const d = new D1Database(sqliteAdapter(new Database(':memory:')));
    await d.exec('create table t (id integer primary key, name text not null)');
    return d;
  };
  test('prepare, bind, run, first, all, raw', async () => {
    const d = await make();
    const r = await d.prepare('insert into t (name) values (?)').bind('ann').run();
    expect(r.success).toBe(true);
    expect(r.meta).toMatchObject({ changes: 1, last_row_id: 1, changed_db: true });
    await d.prepare('insert into t (name) values (?)').bind('bob').run();
    expect(await d.prepare('select name from t where id = ?').bind(2).first('name')).toBe('bob');
    expect(await d.prepare('select * from t where id = 9').first()).toBeNull();
    expect((await d.prepare('select * from t order by id').all()).results).toEqual([
      { id: 1, name: 'ann' },
      { id: 2, name: 'bob' },
    ]);
    expect(await d.prepare('select id, name from t where id = 1').raw({ columnNames: true })).toEqual([['id', 'name'], [1, 'ann']]);
  });
  test('errors carry the D1_ERROR prefix and undefined binds are refused', async () => {
    const d = await make();
    await expect(d.prepare('select * from nope').all()).rejects.toThrow('D1_ERROR');
    expect(() => d.prepare('select ?').bind(undefined)).toThrow('D1_TYPE_ERROR');
  });
  test('exec counts executed statements without counting quoted semicolons or comments', async () => {
    const d = await make();
    expect((await d.exec("insert into t (name) values ('a;b');")).count).toBe(1);
    expect((await d.exec("insert into t (name) values ('c'';d'); \n;\n select * from t;")).count).toBe(2);
    expect((await d.exec('-- comment; with semicolon\nselect 1 /* comment; with semicolon */;')).count).toBe(1);
    expect((await d.prepare('select name from t order by id').all()).results).toEqual([
      { name: 'a;b' },
      { name: "c';d" },
    ]);
  });
  test('exec counts a multi-step trigger as one statement', async () => {
    const d = await make();
    const result = await d.exec(`
      create temporary trigger log_updates after update on t begin
        insert into t (name) values (case when new.name = 'end' then 'updated' else new.name end);
        insert into t (name) values ('finished;');
      end;
      select name as [with;semicolon] from t;
    `);
    expect(result.count).toBe(2);
  });
  test('batch is one transaction: a failing statement undoes the earlier ones', async () => {
    const d = await make();
    await expect(
      d.batch([d.prepare("insert into t (name) values ('x')"), d.prepare('insert into t (name) values (NULL)')]),
    ).rejects.toThrow('D1_ERROR');
    expect((await d.prepare('select count(*) as n from t').first()).n).toBe(0);
    const out = await d.batch([d.prepare("insert into t (name) values ('x')"), d.prepare('select count(*) as n from t')]);
    expect(out[1].results[0].n).toBe(1);
  });
});

const WORKER = `
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/count') {
      const n = Number((await env.CACHE.get('n')) ?? 0) + 1;
      await env.CACHE.put('n', String(n));
      return Response.json({ n, greeting: env.GREETING, colo: request.cf.colo });
    }
    if (url.pathname === '/echo') return new Response(await request.text(), { status: 201, headers: { 'x-seen': request.headers.get('x-in') } });
    if (url.pathname === '/boom') throw new Error('boom');
    if (url.pathname === '/later') { ctx.waitUntil(env.CACHE.put('later', 'done')); return new Response('ok'); }
    if (url.pathname === '/auth') return env.AUTH.fetch('https://auth.local/who');
    if (url.pathname === '/empty') return new Response(null, { status: 204 });
    return new Response('not found', { status: 404 });
  },
  async scheduled(event, env) { await env.CACHE.put('cron', event.cron); },
};`;
const CONFIG = `name = "t"\n[vars]\nGREETING = "hi"\n[[kv_namespaces]]\nbinding = "CACHE"\nid = "x"\n[[services]]\nbinding = "AUTH"\nservice = "auth"\n[triggers]\ncrons = ["*/5 * * * *"]`;

describe('runtime (same thread)', () => {
  const quiet = { onError: () => {} };
  test('fetch handler gets env, request.cf and keeps KV between calls', async () => {
    const rt = await createWorkerRuntime({ code: WORKER, config: CONFIG, services: { auth: { fetch: async () => new Response('x') } }, ...quiet });
    await rt.fetch(new Request('https://w.local/count'));
    const res = await rt.fetch(new Request('https://w.local/count'));
    expect(await res.json()).toEqual({ n: 2, greeting: 'hi', colo: 'BROWSER' });
  });
  test('a thrown error answers like the platform and calls onError', async () => {
    const seen = [];
    const rt = await createWorkerRuntime({ code: WORKER, config: 'name = "t"', onError: (e) => seen.push(e.message) });
    const res = await rt.fetch(new Request('https://w.local/boom'));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('1101');
    expect(seen).toEqual(['boom']);
  });
  test('waitUntil work finishes before idle() resolves; scheduled uses the configured cron', async () => {
    const rt = await createWorkerRuntime({ code: WORKER, config: CONFIG, services: { auth: { fetch: async () => new Response('x') } }, ...quiet });
    await rt.fetch(new Request('https://w.local/later'));
    await rt.idle();
    expect(await rt.env.CACHE.get('later')).toBe('done');
    await rt.scheduled();
    expect(await rt.env.CACHE.get('cron')).toBe('*/5 * * * *');
  });
  test('service bindings call the other worker; a missing one is refused up front', async () => {
    const auth = { fetch: async (req) => new Response(`who:${new URL(req.url).pathname}`) };
    const rt = await createWorkerRuntime({ code: WORKER, config: CONFIG, services: { auth } });
    expect(await (await rt.fetch(new Request('https://w.local/auth'))).text()).toBe('who:/who');
    await expect(createWorkerRuntime({ code: WORKER, config: CONFIG })).rejects.toThrow('"auth"');
  });
  test('a D1 binding without an engine explains how to add one', async () => {
    const rt = await createWorkerRuntime({
      code: 'export default { fetch(r, env) { return new Response(String(env.DB)) } }',
      config: '[[d1_databases]]\nbinding = "DB"\ndatabase_name = "x"',
      onError: () => {},
    });
    const res = await rt.fetch(new Request('https://w.local/'));
    expect(res.status).toBe(500);
  });
  test('code that is not a Worker module is refused', async () => {
    await expect(createWorkerRuntime({ code: 'export const x = 1' })).rejects.toThrow('export default');
    await expect(createWorkerRuntime({ code: '' })).rejects.toThrow('`code`');
  });
  test('the data: URL fallback loads the same module', async () => {
    const { loadModuleFromCode } = await import('../src/runtime.js');
    const original = URL.createObjectURL;
    URL.createObjectURL = undefined;
    try {
      const m = await loadModuleFromCode('export default { fetch: () => new Response("é") }');
      expect(await m.default.fetch().text()).toBe('é');
    } finally {
      URL.createObjectURL = original;
    }
  });
});

describe('startWorker (a real Web Worker thread)', () => {
  test('fetch round trip with a body, headers, status and no-body statuses', async () => {
    const w = await startWorker({ code: WORKER, config: CONFIG, services: { auth: { fetch: async () => new Response('x') } }, onError: () => {} });
    try {
      expect(w.name).toBe('t');
      expect(w.crons).toEqual(['*/5 * * * *']);
      const r = await w.fetch('https://w.local/echo', { method: 'POST', body: 'payload', headers: { 'x-in': 'yes' } });
      expect(r.status).toBe(201);
      expect(r.headers.get('x-seen')).toBe('yes');
      expect(await r.text()).toBe('payload');
      const e = await w.fetch('https://w.local/empty');
      expect(e.status).toBe(204);
      expect((await w.fetch('https://w.local/nope')).status).toBe(404);
      expect(await (await w.fetch('https://w.local/count')).json()).toMatchObject({ n: 1 });
      expect(await (await w.fetch('https://w.local/count')).json()).toMatchObject({ n: 2 });
      await w.scheduled();
      await w.idle();
      const snap = await w.snapshot();
      expect(Object.fromEntries(snap.kv.CACHE).cron.value).toBeInstanceOf(Uint8Array);
    } finally {
      await w.stop();
    }
  });
  test('a service binding is answered by the page-side worker', async () => {
    const auth = await startWorker({ code: 'export default { fetch: (r) => new Response("auth ok " + new URL(r.url).pathname) }' });
    const w = await startWorker({ code: WORKER, config: CONFIG, services: { auth } });
    try {
      expect(await (await w.fetch('https://w.local/auth')).text()).toBe('auth ok /who');
    } finally {
      await w.stop();
      await auth.stop();
    }
  });
  test('a bad Worker fails start with a message; after stop() calls are refused', async () => {
    await expect(startWorker({ code: 'export const nope = 1' })).rejects.toThrow('export default');
    const w = await startWorker({ code: WORKER, config: 'name = "t"', onError: () => {} });
    await w.stop();
    await expect(w.fetch('https://w.local/x')).rejects.toThrow('stopped');
  });
  test('D1 through sql.js (SQLite as WebAssembly) inside the worker thread', async () => {
    const dir = new URL('../vendor/', import.meta.url);
    const w = await startWorker({
      code: `export default { async fetch(r, env) {
        await env.DB.exec('create table if not exists t (n integer)');
        await env.DB.prepare('insert into t values (?)').bind(7).run();
        const row = await env.DB.prepare('select sum(n) as s from t').first();
        return Response.json(row);
      } }`,
      config: '[[d1_databases]]\nbinding = "DB"\ndatabase_name = "x"',
      d1: { module: new URL('../src/d1-sqljs.js', import.meta.url).href, sqlJs: new URL('sql-wasm.js', dir).href, wasm: new URL('sql-wasm.wasm', dir).href },
    });
    try {
      expect(await (await w.fetch('https://w.local/')).json()).toEqual({ s: 7 });
    } finally {
      await w.stop();
    }
  });
});
