// Reads the part of wrangler.toml (or wrangler.json) that a browser worker needs: name, main, vars, bindings, crons.
// A small TOML reader, not a full one: no multi-line strings, no dates. Anything it does not know is kept as data and ignored.
const ws = (p) => {
  for (;;) {
    while (p.i < p.s.length && /\s/.test(p.s[p.i])) p.i++;
    if (p.s[p.i] === '#') while (p.i < p.s.length && p.s[p.i] !== '\n') p.i++;
    else return;
  }
};

function str(p) {
  const q = p.s[p.i++];
  let out = '';
  for (;;) {
    if (p.i >= p.s.length) throw new Error('wrangler.toml: unterminated string');
    const c = p.s[p.i++];
    if (c === q) return out;
    if (q === '"' && c === '\\') {
      const n = p.s[p.i++];
      out += { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[n] ?? n;
    } else out += c;
  }
}

function key(p) {
  ws(p);
  const c = p.s[p.i];
  if (c === '"' || c === "'") return str(p);
  const m = /^[A-Za-z0-9_-]+/.exec(p.s.slice(p.i));
  if (!m) throw new Error(`wrangler.toml: expected a key at offset ${p.i}`);
  p.i += m[0].length;
  return m[0];
}

function keyPath(p) {
  const path = [key(p)];
  for (;;) {
    ws(p);
    if (p.s[p.i] !== '.') return path;
    p.i++;
    path.push(key(p));
  }
}

function expect(p, ch) {
  ws(p);
  if (p.s[p.i] !== ch) throw new Error(`wrangler.toml: expected "${ch}" at offset ${p.i}`);
  p.i++;
}

function val(p) {
  ws(p);
  if (p.i >= p.s.length) throw new Error('wrangler.toml: value missing');
  const c = p.s[p.i];
  if (c === '"' || c === "'") return str(p);
  if (c === '[') {
    p.i++;
    const a = [];
    for (;;) {
      ws(p);
      if (p.s[p.i] === ']') {
        p.i++;
        return a;
      }
      a.push(val(p));
      ws(p);
      if (p.s[p.i] === ',') p.i++;
    }
  }
  if (c === '{') {
    p.i++;
    const o = {};
    for (;;) {
      ws(p);
      if (p.s[p.i] === '}') {
        p.i++;
        return o;
      }
      setPath(o, keyPath(p), (expect(p, '='), val(p)));
      ws(p);
      if (p.s[p.i] === ',') p.i++;
    }
  }
  const m = /^[^\s,\]}#]+/.exec(p.s.slice(p.i));
  if (!m) throw new Error(`wrangler.toml: cannot read a value at offset ${p.i}`);
  p.i += m[0].length;
  const t = m[0];
  if (t === 'true') return true;
  if (t === 'false') return false;
  const n = Number(t.replace(/_/g, ''));
  return Number.isNaN(n) ? t : n;
}

function walk(root, path) {
  let node = root;
  for (const seg of path) {
    node = node[seg] ??= {};
    if (Array.isArray(node)) node = node.at(-1);
  }
  return node;
}

function setPath(obj, path, value) {
  walk(obj, path.slice(0, -1))[path.at(-1)] = value;
}

export function parseToml(text) {
  const p = { s: String(text), i: 0 };
  const root = {};
  let cur = root;
  for (;;) {
    ws(p);
    if (p.i >= p.s.length) return root;
    if (p.s[p.i] === '[') {
      const arr = p.s[p.i + 1] === '[';
      p.i += arr ? 2 : 1;
      const path = keyPath(p);
      expect(p, ']');
      if (arr) expect(p, ']');
      const parent = walk(root, path.slice(0, -1));
      const k = path.at(-1);
      if (arr) (parent[k] ??= []).push((cur = {}));
      else cur = parent[k] ??= {};
    } else {
      const path = keyPath(p);
      expect(p, '=');
      setPath(cur, path, val(p));
    }
  }
}

// Strips // and /* */ comments and trailing commas, for wrangler.jsonc.
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  // Match quoted strings as a unit so they cannot be mistaken for trailing commas.
  return JSON.parse(out.replace(/"(?:\\[\s\S]|[^"\\])*"|,(\s*[}\]])/g, (match, close) => close ?? match));
}

// Returns the same shape for TOML and JSON: { name, main, compatibility_date, vars, kv_namespaces, r2_buckets,
// d1_databases, services, crons }.
export function readConfig(text) {
  const raw = String(text).trimStart().startsWith('{') ? parseJsonc(String(text)) : parseToml(text);
  return {
    name: raw.name ?? 'worker',
    main: raw.main ?? null,
    compatibility_date: raw.compatibility_date ?? null,
    vars: raw.vars ?? {},
    kv_namespaces: raw.kv_namespaces ?? [],
    r2_buckets: raw.r2_buckets ?? [],
    d1_databases: raw.d1_databases ?? [],
    services: raw.services ?? [],
    crons: raw.triggers?.crons ?? [],
  };
}
