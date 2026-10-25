import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clock } from './lib/clock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const nz = (v) => (v === undefined ? null : v);

/** Envolve o SQLite síncrono: cache de statements, transações reentrantes (BEGIN IMMEDIATE). */
export class Db {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
    this.cache = new Map();
    this.depth = 0;
  }
  #stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }
  get(sql, ...p) { return this.#stmt(sql).get(...p.map(nz)); }
  all(sql, ...p) { return this.#stmt(sql).all(...p.map(nz)); }
  run(sql, ...p) { return this.#stmt(sql).run(...p.map(nz)); }
  exec(sql) { this.raw.exec(sql); }
  /** NUNCA use await dentro de fn: transações são síncronas por projeto (evita estados intermediários). */
  tx(fn) {
    if (this.depth > 0) { this.depth++; try { return fn(); } finally { this.depth--; } }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.raw.exec('ROLLBACK'); } catch { /* já revertida */ }
      throw e;
    } finally { this.depth = 0; }
  }
  close() { this.raw.close(); }
}

export function migrate(db) {
  const dir = path.join(here, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const cur = db.get('PRAGMA user_version').user_version;
  for (const f of files) {
    const n = parseInt(f, 10);
    if (n <= cur) continue;
    db.tx(() => {
      db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      db.exec(`PRAGMA user_version = ${n}`);
    });
  }
  seed(db);
}

function seed(db) {
  const now = clock.now();
  const defaults = {
    fee_cents: '200',                  // taxa To Bus por recarga (R$ 2,00)
    min_recharge_cents: '550',         // recarga mínima
    second_via_fee_cents: '1000',      // 2ª via (R$ 10,00)
    refund_window_days: '30',
    max_open_charges: '3',
    charge_ttl_sec: '600',
    daily_recharge_limit_cents: '50000', // teto diário de recargas por usuário
    refund_auto_max_cents: '10000',    // acima disso, sempre análise humana
    refund_max_per_30d: '3',
    rural_default_cents: '740',
    tos_version: '2026-10',
    boarding_max_age_sec: String(7 * 86400),
  };
  for (const [k, v] of Object.entries(defaults)) {
    db.run('INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)', k, v, now);
  }
  // Tarifas de Uberaba conforme o protótipo (CONFIRMAR com Transube/Prefeitura antes de produção).
  if (!db.get('SELECT 1 AS x FROM tariffs LIMIT 1')) {
    db.run('INSERT INTO tariffs VALUES(?,?,?,?)', 'urb', 550, 27500, 0);   // 50 passagens
    db.run('INSERT INTO tariffs VALUES(?,?,?,?)', 'est', 275, 13750, 0);   // 50 passagens
    db.run('INSERT INTO tariffs VALUES(?,?,?,?)', 'rur', 740, 20000, 0);
    for (const [l, n, c, m] of [['12', 'Capelinha do Barreiro', 740, 770], ['16', 'Santa Fé', 790, 820], ['58', 'Ponte Alta', 755, 780], ['61', 'Distrito Industrial III', 770, 800]]) {
      db.run('INSERT INTO rural_fares VALUES(?,?,?,?)', l, n, c, m);
    }
  }
}

export const getSetting = (db, key) => {
  const r = db.get('SELECT value FROM settings WHERE key=?', key);
  if (!r) throw new Error('setting ausente: ' + key);
  return r.value;
};
export const getIntSetting = (db, key) => parseInt(getSetting(db, key), 10);
