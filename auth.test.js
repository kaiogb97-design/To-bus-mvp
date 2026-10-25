import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, makeUser, stepup, PASSWORD, PIN, validCpf } from './helpers.js';
import { clock } from '../src/lib/clock.js';

let ctx;
before(async () => { ctx = await boot(); });
after(async () => { await ctx.close(); });

test('cadastro exige OTP (e-mail + SMS), cria conta, categoria com desconto fica PENDENTE', async () => {
  const u = await makeUser(ctx, { tipo: 'est' });
  const me = (await ctx.call('GET', '/v1/me', { token: u.token })).json;
  assert.equal(me.category, 'urb', 'estudantil não vale por autodeclaração');
  assert.equal(me.benefit_request.status, 'pending');
  assert.equal(me.card.status, 'active');
  assert.equal(me.card.last4, u.number.slice(-4));
  assert.match(me.cpf_masked, /^•••\.\d{3}\.\d{3}-••$/);
});

test('cadastro com CPF/e-mail existente tem resposta idêntica (anti-enumeração) e avisa o dono', async () => {
  const u = await makeUser(ctx);
  ctx.app.limiter.reset();
  const before = ctx.mail('registration_attempt').length;
  const r = await ctx.call('POST', '/v1/auth/register', { body: { nome: 'Joao Pedro Lima', cpf: u.cpf, nasc: '1991-01-20', tel: '34988887777', email: 'outro@x.com.br', cep: '38010000', rua: 'Rua B', num: '1', bairro: 'Centro', cidade: 'Uberaba, MG', tipo: 'urb', senha: PASSWORD, pin: PIN, accept_terms: true, terms_version: '2026-10', device: u.device } });
  assert.equal(r.status, 202);
  assert.ok(r.json.ticket);
  assert.equal(ctx.mail('registration_attempt').length, before + 1);
  const v = await ctx.call('POST', '/v1/auth/register/verify', { body: { ticket: r.json.ticket, email_code: '123456', phone_code: '123456', device: u.device } });
  assert.equal(v.status, 422);
});

test('validação rígida: CPF inválido, menor de 12, campo desconhecido, senha/PIN fracos', async () => {
  const base = { nome: 'Ana Paula Reis', cpf: validCpf(555111222), nasc: '1990-01-01', tel: '34999990000', email: 'a@b.com', cep: '38010000', rua: 'Rua X', num: '1', bairro: 'Centro', cidade: 'Uberaba, MG', tipo: 'urb', senha: PASSWORD, pin: PIN, accept_terms: true, terms_version: '2026-10', device: { id: 'd'.repeat(20) } };
  const t = async (patch) => { ctx.app.limiter.reset(); return (await ctx.call('POST', '/v1/auth/register', { body: { ...base, ...patch } })); };
  assert.equal((await t({ cpf: '11111111111' })).json.error.code, 'invalid_cpf');
  assert.equal((await t({ nasc: '2030-01-01' })).json.error.code, 'invalid_birth');
  assert.equal((await t({ nasc: '2023-02-30' })).json.error.code, 'invalid_birth');
  assert.equal((await t({ nasc: '2020-01-01' })).json.error.code, 'too_young');
  assert.equal((await t({ senha: '12345678' })).json.error.code, 'weak_password');
  assert.equal((await t({ pin: '1234' })).json.error.code, 'weak_pin');
  assert.equal((await t({ nome: '<script>alert(1)</script> X' })).json.error.code, 'invalid_name');
  assert.equal((await t({ admin: true })).json.error.code, 'unknown_field', 'mass assignment bloqueado');
  assert.equal((await t({ accept_terms: false })).json.error.code, 'terms_required');
});

test('idade no dia exato do aniversário (bug de fuso do protótipo): 12 anos hoje é aceito', async () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(clock.now())).split('-');
  const nasc = `${+p[0] - 12}-${p[1]}-${p[2]}`;
  const u = await makeUser(ctx, { nasc });
  assert.ok(u.id);
});

test('login: senha errada é genérica; bloqueio progressivo persistido após 5 falhas', async () => {
  const u = await makeUser(ctx);
  const login = (pw) => ctx.call('POST', '/v1/auth/login', { body: { id: u.cpf, password: pw, device: u.device } });
  for (let i = 0; i < 5; i++) { ctx.app.limiter.reset(); const r = await login('errada-' + i); assert.equal(r.status, 401); assert.equal(r.json.error.code, 'invalid_credentials'); }
  ctx.app.limiter.reset();
  const locked = await login(PASSWORD);
  assert.equal(locked.status, 429, 'mesmo com a senha certa, conta bloqueada');
  assert.ok(locked.headers.get('retry-after'));
  clock.advance(31 * 60_000);
  ctx.app.limiter.reset();
  assert.equal((await login(PASSWORD)).status, 200);
  assert.equal(ctx.mail('account_locked').length >= 1, true);
});

test('login: usuário inexistente e senha errada são indistinguíveis', async () => {
  ctx.app.limiter.reset();
  const a = await ctx.call('POST', '/v1/auth/login', { body: { id: validCpf(987654321), password: 'qualquer-coisa', device: { id: 'x'.repeat(20) } } });
  assert.equal(a.status, 401); assert.equal(a.json.error.code, 'invalid_credentials');
});

test('dispositivo novo exige código por e-mail', async () => {
  const u = await makeUser(ctx);
  ctx.app.limiter.reset();
  const dev2 = { id: crypto.randomUUID().replace(/-/g, ''), label: 'Outro' };
  const r1 = await ctx.call('POST', '/v1/auth/login', { body: { id: u.email, password: PASSWORD, device: dev2 } });
  assert.equal(r1.json.error.code, 'device_verification_required');
  const bad = await ctx.call('POST', '/v1/auth/login', { body: { id: u.email, password: PASSWORD, device: dev2, otp: '000000' } });
  assert.equal(bad.json.error.code, 'invalid_otp');
  const ok = await ctx.call('POST', '/v1/auth/login', { body: { id: u.email, password: PASSWORD, device: dev2, otp: ctx.otp('email') } });
  assert.equal(ok.status, 200);
});

test('refresh rotaciona; REUSO do refresh antigo derruba toda a família de sessões', async () => {
  const u = await makeUser(ctx);
  const r1 = await ctx.call('POST', '/v1/auth/refresh', { body: { refresh_token: u.refresh, device_id: u.device.id } });
  assert.equal(r1.status, 200);
  assert.equal((await ctx.call('GET', '/v1/me', { token: u.token })).status, 401, 'access antigo deixa de valer');
  assert.equal((await ctx.call('GET', '/v1/me', { token: r1.json.access_token })).status, 200);
  const reuse = await ctx.call('POST', '/v1/auth/refresh', { body: { refresh_token: u.refresh, device_id: u.device.id } });
  assert.equal(reuse.status, 401);
  assert.equal((await ctx.call('GET', '/v1/me', { token: r1.json.access_token })).status, 401, 'família inteira revogada');
});

test('access token expira; refresh em outro dispositivo é recusado', async () => {
  const u = await makeUser(ctx);
  const bad = await ctx.call('POST', '/v1/auth/refresh', { body: { refresh_token: u.refresh, device_id: 'z'.repeat(20) } });
  assert.equal(bad.status, 401);
  clock.advance(16 * 60_000);
  assert.equal((await ctx.call('GET', '/v1/me', { token: u.token })).json.error.code, 'token_expired');
});

test('rotas protegidas recusam sem token / token forjado', async () => {
  assert.equal((await ctx.call('GET', '/v1/me')).status, 401);
  assert.equal((await ctx.call('GET', '/v1/me', { token: 'tb_at_' + 'A'.repeat(43) })).status, 401);
  assert.equal((await ctx.call('GET', '/v1/admin/refunds', { token: 'tb_at_' + 'A'.repeat(43) })).status, 401);
});

test('PIN: verificado no servidor, 5 erros bloqueiam (persistido), step-up é de uso único e por escopo', async () => {
  const u = await makeUser(ctx);
  const su = await stepup(ctx, u, 'card.block');
  const b1 = await ctx.call('POST', `/v1/cards/${u.card.id}/block`, { token: u.token, headers: su, body: { reason: 'temporary' } });
  assert.equal(b1.status, 200);
  const reuse = await ctx.call('POST', `/v1/cards/${u.card.id}/unblock`, { token: u.token, headers: su });
  assert.equal(reuse.json.error.code, 'stepup_required', 'token de outro escopo/uso único');
  const noStep = await ctx.call('POST', `/v1/cards/${u.card.id}/unblock`, { token: u.token });
  assert.equal(noStep.json.error.code, 'stepup_required', 'sem step-up não executa (o protótipo permitia burlar no console)');
  for (let i = 0; i < 4; i++) { const r = await ctx.call('POST', '/v1/stepup', { token: u.token, body: { method: 'pin', pin: '0001', scope: 'card.unblock' } }); assert.equal(r.json.error.code, 'pin_invalid'); }
  const r5 = await ctx.call('POST', '/v1/stepup', { token: u.token, body: { method: 'pin', pin: '0001', scope: 'card.unblock' } });
  assert.equal(r5.json.error.code, 'pin_invalid');
  const locked = await ctx.call('POST', '/v1/stepup', { token: u.token, body: { method: 'pin', pin: PIN, scope: 'card.unblock' } });
  assert.equal(locked.status, 429); assert.equal(locked.json.error.code, 'pin_locked');
});

test('biometria verificada no servidor (ECDSA P-256 do Keystore): assinatura válida passa, adulterada falha, nonce é de uso único', async () => {
  const u = await makeUser(ctx);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const enroll = await ctx.call('POST', '/v1/stepup/biometric/enroll', { token: u.token, headers: await stepup(ctx, u, 'biometric.enroll'), body: { public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } });
  assert.equal(enroll.status, 200);
  const ch = (await ctx.call('POST', '/v1/stepup/challenge', { token: u.token })).json;
  const sign = (data) => crypto.sign('sha256', Buffer.from(data), privateKey).toString('base64');
  const bad = await ctx.call('POST', '/v1/stepup', { token: u.token, body: { method: 'biometric', scope: 'card.block', nonce: ch.nonce, signature: sign(ch.nonce + '.card.unblock') } });
  assert.equal(bad.json.error.code, 'biometric_invalid', 'assinatura de outro escopo');
  const ch2 = (await ctx.call('POST', '/v1/stepup/challenge', { token: u.token })).json;
  const ok = await ctx.call('POST', '/v1/stepup', { token: u.token, body: { method: 'biometric', scope: 'card.block', nonce: ch2.nonce, signature: sign(ch2.nonce + '.card.block') } });
  assert.equal(ok.status, 200);
  const replay = await ctx.call('POST', '/v1/stepup', { token: u.token, body: { method: 'biometric', scope: 'card.block', nonce: ch2.nonce, signature: sign(ch2.nonce + '.card.block') } });
  assert.equal(replay.status, 422, 'replay do nonce');
  const otherKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const ch3 = (await ctx.call('POST', '/v1/stepup/challenge', { token: u.token })).json;
  const forged = await ctx.call('POST', '/v1/stepup', { token: u.token, body: { method: 'biometric', scope: 'card.block', nonce: ch3.nonce, signature: crypto.sign('sha256', Buffer.from(ch3.nonce + '.card.block'), otherKey).toString('base64') } });
  assert.equal(forged.status, 422, 'chave privada diferente');
});

test('troca de senha por reset exige e-mail + SMS e derruba sessões', async () => {
  const u = await makeUser(ctx);
  ctx.app.limiter.reset();
  const f = await ctx.call('POST', '/v1/auth/password/forgot', { body: { id: u.cpf } });
  assert.equal(f.status, 202);
  const f2 = await ctx.call('POST', '/v1/auth/password/forgot', { body: { id: validCpf(123123123) } });
  assert.deepEqual(f2.json, f.json, 'resposta idêntica p/ conta inexistente');
  const r = await ctx.call('POST', '/v1/auth/password/reset', { body: { id: u.cpf, email_code: ctx.otp('email'), phone_code: ctx.otp('sms'), new_password: 'Nova!Senha#2026x' } });
  assert.equal(r.status, 200);
  assert.equal((await ctx.call('GET', '/v1/me', { token: u.token })).status, 401);
  ctx.app.limiter.reset();
  assert.equal((await ctx.call('POST', '/v1/auth/login', { body: { id: u.cpf, password: 'Nova!Senha#2026x', device: u.device } })).status, 200);
});

test('hardening HTTP: headers, CORS por allowlist, content-type, corpo grande, JSON inválido, 404, sem vazamento de erro', async () => {
  const r = await ctx.call('GET', '/healthz');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('strict-transport-security'), /max-age/);
  assert.equal(r.headers.get('x-powered-by'), null);
  const ok = await fetch(ctx.base + '/healthz', { headers: { origin: 'https://appassets.androidplatform.net' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://appassets.androidplatform.net');
  const evil = await fetch(ctx.base + '/healthz', { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const nul = await fetch(ctx.base + '/healthz', { headers: { origin: 'null' } });
  assert.equal(nul.headers.get('access-control-allow-origin'), null, 'origin "null" (file://) não é aceito');
  assert.equal((await ctx.call('POST', '/v1/auth/login', { raw: 'x=1', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await ctx.call('POST', '/v1/auth/login', { raw: '{oops' })).json.error.code, 'invalid_json');
  assert.equal((await ctx.call('POST', '/v1/auth/login', { raw: JSON.stringify({ a: 'x'.repeat(70000) }) })).status, 413);
  assert.equal((await ctx.call('GET', '/v1/nada')).status, 404);
  const sqli = await ctx.call('POST', '/v1/auth/login', { body: { id: "' OR 1=1 --", password: 'x', device: { id: 'x'.repeat(20) } } });
  assert.equal(sqli.status, 401);
});

test('rate limit por IP responde 429 com Retry-After', async () => {
  const c2 = await boot();
  let last;
  for (let i = 0; i < 35; i++) last = await c2.call('POST', '/v1/auth/login', { body: { id: 'abc@x.com', password: 'x', device: { id: 'x'.repeat(20) } } });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
  await c2.close();
});
