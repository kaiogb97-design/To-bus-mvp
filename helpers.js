process.env.NODE_ENV = 'test';
import crypto from 'node:crypto';
import { createApp, listen, shutdown } from '../src/app.js';
import { ConsoleNotifier } from '../src/adapters/notify.js';
import { signWebhook } from '../src/adapters/psp.js';
import { signValidatorRequest, createValidator } from '../src/services/boarding.js';
import { clock } from '../src/lib/clock.js';
import { createAdmin } from '../src/services/admin.js';
import { totpAt } from '../src/lib/crypto.js';

export function validCpf(seed) {
  const d = String(seed).padStart(9, '0').slice(0, 9).split('').map(Number);
  for (let t = 9; t < 11; t++) { let s = 0; for (let i = 0; i < t; i++) s += d[i] * (t + 1 - i); d.push(((s * 10) % 11) % 10); }
  return d.join('');
}
let seq = 100;
export async function boot(cfg = {}) {
  clock.reset();
  const notifier = new ConsoleNotifier();
  const app = createApp({ cfg: { port: 0, ...cfg }, notifier });
  const addr = await listen(app);
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (method, path, { body, token, headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = 'Bearer ' + token;
    let payload;
    if (raw !== undefined) payload = raw; else if (body !== undefined) payload = JSON.stringify(body);
    if (payload !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers: h, body: payload });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* */ }
    return { status: r.status, json, headers: r.headers };
  };
  const ctx = { app, base, call, notifier, close: () => shutdown(app) };
  ctx.otp = (channel) => [...notifier.sent].reverse().find((m) => m.template === 'otp' && m.channel === channel)?.vars.code;
  ctx.mail = (template) => notifier.sent.filter((m) => m.template === template);
  return ctx;
}

export const PASSWORD = 'Cafe!Roxo#47', PIN = '7391';
export async function makeUser(ctx, o = {}) {
  ctx.app.limiter.reset();
  const n = ++seq;
  const cpf = o.cpf || validCpf(100000000 + n * 7919);
  const email = o.email || `user${n}@exemplo.com.br`;
  const device = { id: crypto.randomUUID().replace(/-/g, ''), label: 'Pixel Teste' };
  const body = {
    nome: o.nome || 'Maria Aparecida Souza', cpf, nasc: o.nasc || '1990-03-15', tel: '(34) 99912-' + String(1000 + n).slice(-4), email,
    cep: '38010-000', rua: 'Rua Teste', num: '10', bairro: 'Centro', cidade: 'Uberaba, MG', tipo: o.tipo || 'urb',
    card_number: o.card === false ? undefined : (o.card || '5039' + String(n).padStart(12, '0')), senha: PASSWORD, pin: o.pin || PIN,
    accept_terms: true, terms_version: '2026-10', device,
  };
  if (body.card_number === undefined) delete body.card_number;
  const r = await ctx.call('POST', '/v1/auth/register', { body });
  if (r.status !== 202) throw new Error('register falhou: ' + JSON.stringify(r.json));
  const v = await ctx.call('POST', '/v1/auth/register/verify', { body: { ticket: r.json.ticket, email_code: ctx.otp('email'), phone_code: ctx.otp('sms'), device } });
  if (v.status !== 201) throw new Error('verify falhou: ' + JSON.stringify(v.json));
  const me = (await ctx.call('GET', '/v1/me', { token: v.json.access_token })).json;
  return { cpf, email, device, token: v.json.access_token, refresh: v.json.refresh_token, id: me.id, card: me.card, number: body.card_number, pin: body.pin };
}
export async function stepup(ctx, u, scope) {
  const r = await ctx.call('POST', '/v1/stepup', { token: u.token, body: { method: 'pin', pin: u.pin || PIN, scope } });
  if (r.status !== 200) throw new Error('stepup falhou: ' + JSON.stringify(r.json));
  return { 'x-stepup': r.json.stepup_token };
}
let idem = 0;
export const idemKey = () => 'idem' + String(++idem).padStart(14, '0') + crypto.randomBytes(4).toString('hex');

/** Cria cobrança Pix e simula o PSP pagando o valor exato. Retorna o saldo creditado. */
export async function recharge(ctx, u, amount, { pay = true, total } = {}) {
  const c = await ctx.call('POST', '/v1/recharges', { token: u.token, headers: { 'idempotency-key': idemKey() }, body: { amount_cents: amount, method: 'pix' } });
  if (c.status !== 201) throw new Error('recharge falhou: ' + JSON.stringify(c.json));
  if (pay) await pspPay(ctx, c.json.id, total ?? c.json.total_cents);
  return c.json;
}
export async function pspPay(ctx, chargeId, totalCents, eventId = crypto.randomUUID()) {
  const row = ctx.app.db.get('SELECT psp_txid FROM charges WHERE id=?', chargeId);
  const raw = JSON.stringify({ event_id: eventId, type: 'pix.paid', txid: row.psp_txid, paid_total_cents: totalCents, paid_at: Date.now() });
  return ctx.call('POST', '/v1/webhooks/psp', { raw, headers: { 'x-tobus-signature': signWebhook('dev-psp-secret', raw, clock.now()) } });
}
export function newValidator(ctx) { return createValidator(ctx.app, 'Validador Teste'); }
export async function board(ctx, v, number, { line = '105', event = crypto.randomUUID(), at } = {}) {
  const raw = JSON.stringify({ event_id: event, card_number: number, line, occurred_at: at ?? clock.now() });
  const ts = String(clock.now());
  return ctx.call('POST', '/v1/validator/boardings', { raw, headers: { 'x-validator-id': v.id, 'x-timestamp': ts, 'x-signature': signValidatorRequest(v.secret, ts, '/v1/validator/boardings', raw) } });
}
export async function adminSession(ctx, role = 'superadmin') {
  const a = await createAdmin(ctx.app, `adm${++seq}@tobus.test`, role);
  clock.advance(31_000 * (seq % 3 + 1)); // garante passo TOTP novo
  const r = await ctx.call('POST', '/v1/admin/login', { body: { email: a.email, password: a.password, totp: totpAt(a.totp_secret, Math.floor(clock.now() / 30000)) } });
  if (r.status !== 200) throw new Error('admin login falhou ' + JSON.stringify(r.json));
  return { ...a, token: r.json.token };
}
