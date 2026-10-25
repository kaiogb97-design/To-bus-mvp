// Executa o JS REAL do app (todos os módulos) em um contexto vm com DOM simulado, falando com o servidor REAL.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
process.env.NODE_ENV = 'test';
const WWW = '../app/www';

function el() {
  const store = { innerHTML: '', textContent: '', value: '', dataset: {}, style: new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }), children: [], offsetWidth: 0, scrollTop: 0 };
  const fn = () => {};
  const p = new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k in store) return store[k];
      if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (k === 'then') return undefined;
      if (k === 'animate') return () => ({ finished: Promise.resolve(), cancel() {}, onfinish: null });
      if (['querySelector', 'querySelectorAll', 'closest'].includes(k)) return () => (k === 'querySelectorAll' ? [] : el());
      return el();
    },
    set(t, k, v) { store[k] = v; return true; },
    apply() { return el(); },
  });
  return p;
}
export function loadApp({ cfg, fetchImpl }) {
  const ls = new Map();
  const localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), key: (i) => [...ls.keys()][i], get length() { return ls.size; } };
  const toasts = [], reg = {};
  const doc = { hidden: false, body: el(), documentElement: el(), createElement: () => el(), querySelector: (sel) => reg[sel] || (reg[sel] = el()), querySelectorAll: () => [], getElementById: () => el(), addEventListener() {}, removeEventListener() {}, createTextNode: () => el(), createRange: () => ({ createContextualFragment: () => el(), selectNodeContents() {}, setStart() {}, setEnd() {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }), getClientRects: () => [], toString: () => '' }), execCommand: () => true, fonts: { ready: Promise.resolve() } };
  const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON, Intl, URL, TextEncoder, TextDecoder, AbortController, crypto: globalThis.crypto, performance, localStorage, document: doc,
    navigator: { userAgent: 'HarnessAndroid', clipboard: { writeText: async () => {} } }, fetch: fetchImpl, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({}), scrollTo() {}, history: { pushState() {} }, location: { hash: '', href: 'file:///android_asset/www/index.html' },
    TOBUS_CONFIG: cfg, structuredClone, atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'), alert() {}, confirm: () => true, Event: class {}, CustomEvent: class {} };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  const files = ['config.js', 'js/01-core.js', 'js/02-home-recargas-tarifas.js', 'js/03-cartao-perfil-chat.js', 'js/04-fluxo-recarga.js', 'js/05-bloqueio-pin.js', 'js/06-novidades-extrato.js', 'js/07-linhas.js', 'js/08-login-cadastro.js', 'js/09-reembolso-segunda-via.js', 'js/api-client.js', 'js/10-server-mode.js'];
  // config.js do pacote define TOBUS_CONFIG; no teste sobrescrevemos depois
  for (const f of files) {
    if (f === 'config.js') continue;
    try { vm.runInContext(fs.readFileSync(path.join(WWW, f), 'utf8'), ctx, { filename: f }); }
    catch (e) { throw new Error(`erro ao carregar ${f}: ${e.stack.split('\n').slice(0, 3).join(' | ')}`); }
  }
  
  // Piloto automático dos diálogos (ask): preenche campos #ak_<id> e clica em #ak_ok
  const queue = []; const errors = [];
  const timer = setInterval(() => {
    const ok = reg['#ak_ok'];
    if (ok && ok.onclick && queue.length) {
      const q = queue.shift(), a = typeof q === 'function' ? q() : q;
      for (const [k, v] of Object.entries(a)) (reg['#ak_' + k] || (reg['#ak_' + k] = el())).value = v;
      const f = ok.onclick; ok.onclick = null; Promise.resolve(f());
    }
  }, 5);
  return { ctx, run: (code) => vm.runInContext(code, ctx), localStorage, ls, answer: (...a) => queue.push(...a), pending: () => queue.length, reg, stop: () => clearInterval(timer), errText: () => (reg['#ak_e'] && reg['#ak_e'].textContent) || '' };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
