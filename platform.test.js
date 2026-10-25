import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, makeUser, stepup, recharge, pspPay, newValidator, board, adminSession, PASSWORD } from './helpers.js';
import { signWebhook } from '../src/adapters/psp.js';
import { totpAt } from '../src/lib/crypto.js';
import { createAdmin } from '../src/services/admin.js';
import { clock } from '../src/lib/clock.js';
import { loadConfig } from '../src/config.js';
import { verifyLedger } from '../src/core/ledger.js';

let ctx;
before(async () => { ctx = await boot(); });
after(async () => { await ctx.close(); });

test('dados pessoais NÃO ficam em claro no banco (criptografia de campo + índice cego)', async () => {
  const u = await makeUser(ctx, { nome: 'Joaquim Teodoro Pereira' });
  const dump = JSON.stringify([ctx.app.db.all('SELECT * FROM users'), ctx.app.db.all('SELECT * FROM cards'), ctx.app.db.all('SELECT * FROM outbox'), ctx.app.db.all('SELECT * FROM registrations')]);
  for (const secret of [u.cpf, u.email, 'Joaquim', u.number, '(34) 99912']) assert.ok(!dump.includes(secret), 'vazou em claro: ' + secret);
  assert.ok(!dump.includes(PASSWORD) && !dump.includes('7391'));
  const row = ctx.app.db.get('SELECT pw_hash, pin_hash, pii FROM users WHERE id=?', u.id);
  assert.match(row.pw_hash, /^s1\$/); assert.match(row.pii, /^e1\./);
});

test('adulterar o texto cifrado (ou trocar o contexto) é detectado (AES-GCM com AAD)', async () => {
  const u = await makeUser(ctx);
  const a = ctx.app.db.get('SELECT pii FROM users WHERE id=?', u.id).pii;
  const parts = a.split('.'); parts[4] = Buffer.from('xxxx' + Buffer.from(parts[4], 'base64url').toString('latin1')).toString('base64url');
  ctx.app.db.run('UPDATE users SET pii=? WHERE id=?', parts.join('.'), u.id);
  assert.equal((await ctx.call('GET', '/v1/me', { token: u.token })).status, 500);
});

test('rotação de chave: dado cifrado com chave antiga continua legível', async () => {
  const { encryptField, decryptField } = await import('../src/lib/crypto.js');
  const cfgOld = { dataKeyId: 'k1', dataKeys: { k1: crypto.randomBytes(32) } };
  const blob = encryptField('segredo', 'ctx', cfgOld);
  const cfgNew = { dataKeyId: 'k2', dataKeys: { k1: cfgOld.dataKeys.k1, k2: crypto.randomBytes(32) } };
  assert.equal(decryptField(blob, 'ctx', cfgNew), 'segredo');
  assert.match(encryptField('x', 'c', cfgNew), /^e1\.k2\./);
  assert.throws(() => decryptField(blob, 'outro-contexto', cfgNew));
});

test('concorrência: 20 webhooks simultâneos do mesmo evento creditam UMA vez', async () => {
  const u = await makeUser(ctx);
  const c = await recharge(ctx, u, 2000, { pay: false });
  const row = ctx.app.db.get('SELECT psp_txid FROM charges WHERE id=?', c.id);
  const raw = JSON.stringify({ event_id: 'evt-par-' + crypto.randomUUID(), type: 'pix.paid', txid: row.psp_txid, paid_total_cents: 2200 });
  const sig = signWebhook('dev-psp-secret', raw, clock.now());
  const rs = await Promise.all(Array.from({ length: 20 }, () => ctx.call('POST', '/v1/webhooks/psp', { raw, headers: { 'x-tobus-signature': sig } })));
  assert.equal(rs.filter((r) => r.json.outcome === 'credited').length, 1);
  assert.equal((await ctx.call('GET', '/v1/me', { token: u.token })).json.account.balance_cents, 2000);
});

test('concorrência: 2 eventos distintos para a mesma cobrança => 1 crédito + 1 devolução', async () => {
  const u = await makeUser(ctx);
  const c = await recharge(ctx, u, 2000, { pay: false });
  const rs = await Promise.all([pspPay(ctx, c.id, 2200), pspPay(ctx, c.id, 2200), pspPay(ctx, c.id, 2200)]);
  assert.equal(rs.filter((r) => r.json.outcome === 'credited').length, 1);
  assert.equal(rs.filter((r) => r.json.outcome === 'duplicate_payment').length, 2);
  assert.equal((await ctx.call('GET', '/v1/me', { token: u.token })).json.account.balance_cents, 2000);
});

test('concorrência: embarques paralelos não deixam o saldo negativo nem debitam além do disponível', async () => {
  const v = newValidator(ctx); const u = await makeUser(ctx);
  await recharge(ctx, u, 1100); // 2 passagens
  const rs = await Promise.all(Array.from({ length: 8 }, () => board(ctx, v, u.number)));
  assert.equal(rs.filter((r) => r.json.decision === 'approved').length, 2);
  assert.equal((await ctx.call('GET', '/v1/me', { token: u.token })).json.account.balance_cents, 0);
  assert.equal(verifyLedger(ctx.app.db).ok, true);
});

test('backoffice: exige senha + TOTP; código TOTP não pode ser reutilizado; bloqueio após 5 falhas', async () => {
  const a = await createAdmin(ctx.app, 'ops@tobus.test', 'superadmin');
  const login = (totp, pw = a.password) => ctx.call('POST', '/v1/admin/login', { body: { email: a.email, password: pw, totp } });
  clock.advance(65_000); ctx.app.limiter.reset();
  const code = totpAt(a.totp_secret, Math.floor(clock.now() / 30000));
  assert.equal((await login('000000')).status, 401, 'TOTP errado');
  assert.equal((await login(code, 'senha-errada')).status, 401, 'senha errada');
  const ok = await login(code); assert.equal(ok.status, 200);
  assert.equal((await login(code)).status, 401, 'mesmo código TOTP não vale duas vezes');
  for (let i = 0; i < 5; i++) { ctx.app.limiter.reset(); await login('000000'); }
  ctx.app.limiter.reset();
  clock.advance(31_000);
  assert.equal((await login(totpAt(a.totp_secret, Math.floor(clock.now() / 30000)))).status, 429, 'conta de admin bloqueada');
  // token de usuário comum não acessa backoffice
  const u = await makeUser(ctx);
  assert.equal((await ctx.call('GET', '/v1/admin/refunds', { token: u.token })).status, 401);
});

test('backoffice: criar validador só para superadmin; segredo só aparece na criação', async () => {
  const sup = await adminSession(ctx, 'support'), root = await adminSession(ctx, 'superadmin');
  assert.equal((await ctx.call('POST', '/v1/admin/validators', { token: sup.token, body: { name: 'Onibus 105' } })).json.error.code, 'insufficient_role');
  const r = await ctx.call('POST', '/v1/admin/validators', { token: root.token, body: { name: 'Onibus 105' } });
  assert.equal(r.status, 201); assert.ok(r.json.secret);
  const raw = ctx.app.db.get('SELECT secret_enc FROM validators WHERE id=?', r.json.id).secret_enc;
  assert.ok(!raw.includes(r.json.secret), 'segredo do validador cifrado em repouso');
});

test('LGPD: exportação exige step-up; exclusão exige saldo zero e anonimiza, preservando o razão', async () => {
  const u = await makeUser(ctx);
  assert.equal((await ctx.call('GET', '/v1/me/export', { token: u.token })).json.error.code, 'stepup_required');
  const ex = await ctx.call('GET', '/v1/me/export', { token: u.token, headers: await stepup(ctx, u, 'data.export') });
  assert.equal(ex.status, 200); assert.ok(ex.json.profile.nome);
  const v = newValidator(ctx);
  await recharge(ctx, u, 1100);
  assert.equal((await ctx.call('DELETE', '/v1/me', { token: u.token, headers: await stepup(ctx, u, 'account.delete') })).json.error.code, 'balance_must_be_zero');
  await board(ctx, v, u.number); await board(ctx, v, u.number);
  const del = await ctx.call('DELETE', '/v1/me', { token: u.token, headers: await stepup(ctx, u, 'account.delete') });
  assert.equal(del.status, 200);
  const row = ctx.app.db.get('SELECT * FROM users WHERE id=?', u.id);
  assert.equal(row.status, 'deleted'); assert.equal(row.cpf_idx, null); assert.equal(row.email_idx, null);
  assert.ok(ctx.app.db.get('SELECT COUNT(*) AS n FROM ledger WHERE user_id=?', u.id).n >= 3, 'razão preservado');
  assert.equal((await ctx.call('GET', '/v1/me', { token: u.token })).status, 401);
  assert.equal(verifyLedger(ctx.app.db).ok, true);
});

test('troca de e-mail exige step-up + código no NOVO e-mail e avisa o antigo', async () => {
  const u = await makeUser(ctx);
  const start = await ctx.call('POST', '/v1/me/contact', { token: u.token, headers: await stepup(ctx, u, 'profile.edit'), body: { channel: 'email', value: 'novo.' + u.email } });
  assert.equal(start.status, 200);
  const wrong = await ctx.call('POST', '/v1/me/contact/confirm', { token: u.token, body: { change_id: start.json.change_id, code: '000000' } });
  assert.equal(wrong.status, 422);
  const code = ctx.otp('email');
  const ok = await ctx.call('POST', '/v1/me/contact/confirm', { token: u.token, body: { change_id: start.json.change_id, code } });
  assert.equal(ok.json.email, 'novo.' + u.email);
  assert.ok(ctx.mail('contact_changed').some((m) => m.to === u.email), 'aviso ao e-mail antigo');
  ctx.app.limiter.reset();
  assert.equal((await ctx.call('POST', '/v1/auth/login', { body: { id: 'novo.' + u.email, password: PASSWORD, device: u.device } })).status, 200);
});

test('extrato vem do razão, paginado, sem dados de terceiros', async () => {
  const u = await makeUser(ctx); const v = newValidator(ctx);
  await recharge(ctx, u, 2000); await board(ctx, v, u.number);
  const s = await ctx.call('GET', '/v1/me/statement?limit=1', { token: u.token });
  assert.equal(s.json.items.length, 1); assert.equal(s.json.items[0].kind, 'boarding'); assert.equal(s.json.items[0].balance_after, 1450);
  const s2 = await ctx.call('GET', `/v1/me/statement?limit=10&before=${s.json.next_before}`, { token: u.token });
  assert.equal(s2.json.items[0].kind, 'recharge');
});

test('PIN: troca exige PIN atual e rejeita PIN fraco; nova senha/PIN vale no step-up', async () => {
  const u = await makeUser(ctx);
  assert.equal((await ctx.call('POST', '/v1/me/pin', { token: u.token, body: { current_pin: '0000', new_pin: '4826' } })).json.error.code, 'pin_invalid');
  assert.equal((await ctx.call('POST', '/v1/me/pin', { token: u.token, body: { current_pin: u.pin, new_pin: '1234' } })).json.error.code, 'weak_pin');
  assert.equal((await ctx.call('POST', '/v1/me/pin', { token: u.token, body: { current_pin: u.pin, new_pin: '4826' } })).status, 200);
  assert.equal((await ctx.call('POST', '/v1/stepup', { token: u.token, body: { method: 'pin', pin: u.pin, scope: 'card.block' } })).status, 422);
  assert.equal((await ctx.call('POST', '/v1/stepup', { token: u.token, body: { method: 'pin', pin: '4826', scope: 'card.block' } })).status, 200);
});

test('auditoria: eventos sensíveis registrados e cadeia íntegra', async () => {
  const { verifyAudit } = await import('../src/core/audit.js');
  const r = verifyAudit(ctx.app.db);
  assert.equal(r.ok, true); assert.ok(r.checked > 20);
  const actions = new Set(ctx.app.db.all('SELECT DISTINCT action FROM audit_log').map((x) => x.action));
  for (const a of ['register.completed', 'login.success', 'webhook.credited', 'refund.paid']) assert.ok(actions.has(a), 'falta ' + a);
});

test('produção falha FECHADO: sem segredos, mock ou origem "*" o servidor não sobe', () => {
  const keep = { ...process.env };
  const run = (env) => { Object.assign(process.env, { NODE_ENV: 'production' }, env); try { return loadConfig(); } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); } };
  assert.throws(() => run({}), /obrigat|ausente/i);
  const k = () => crypto.randomBytes(32).toString('base64');
  const full = { DATA_KEY_K1: k(), INDEX_KEY: k(), PASSWORD_PEPPER: k(), OTP_KEY: k(), VALIDATOR_SECRET_KEY: k(), DB_PATH: '/tmp/x.db', PSP_WEBHOOK_SECRETS: 'abc' };
  assert.throws(() => run(full), /mock/i);
  assert.throws(() => run({ ...full, ALLOW_MOCK_ADAPTERS: '1', ALLOWED_ORIGINS: '*' }), /ALLOWED_ORIGINS/);
  assert.throws(() => run({ ...full, ALLOW_MOCK_ADAPTERS: '1', SCRYPT_N: '1024' }), /SCRYPT_N/);
  assert.ok(run({ ...full, ALLOW_MOCK_ADAPTERS: '1' }));
});

test('pedido de cartão novo: só sem cartão; entra pendente de ativação; extrato traz a linha do embarque', async () => {
  const u = await makeUser(ctx, { card: false });
  const r = await ctx.call('POST', '/v1/cards/request', { token: u.token });
  assert.equal(r.status, 201); assert.equal(r.json.status, 'pending_activation');
  assert.equal((await ctx.call('POST', '/v1/cards/request', { token: u.token })).json.error.code, 'card_already_bound');
  const v = newValidator(ctx), w = await makeUser(ctx); await recharge(ctx, w, 1100); await board(ctx, v, w.number, { line: '61' });
  const st = (await ctx.call('GET', '/v1/me/statement', { token: w.token })).json.items;
  assert.equal(st[0].line, '61'); assert.equal(st[0].meta, undefined);
});
