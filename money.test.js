import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, makeUser, stepup, recharge, pspPay, newValidator, board, idemKey, adminSession } from './helpers.js';
import { signWebhook } from '../src/adapters/psp.js';
import { clock } from '../src/lib/clock.js';
import { verifyLedger } from '../src/core/ledger.js';
import { verifyAudit } from '../src/core/audit.js';

let ctx, val;
before(async () => { ctx = await boot(); val = newValidator(ctx); });
after(async () => { await ctx.close(); });
const bal = async (u) => (await ctx.call('GET', '/v1/me', { token: u.token })).json.account;

test('recarga: saldo SÓ sobe após webhook assinado com valor exato; taxa não vira crédito', async () => {
  const u = await makeUser(ctx);
  const c = await recharge(ctx, u, 2000, { pay: false });
  assert.equal(c.total_cents, 2200); assert.equal(c.fee_cents, 200);
  assert.match(c.pix_payload, /^000201.*6304[0-9A-F]{4}$/, 'BR Code com CRC16');
  assert.equal((await bal(u)).balance_cents, 0, 'criar cobrança não credita');
  await pspPay(ctx, c.id, 2200);
  assert.equal((await bal(u)).balance_cents, 2000, 'credita 20,00 (não 22,00)');
  assert.equal((await ctx.call('GET', `/v1/recharges/${c.id}`, { token: u.token })).json.status, 'paid');
});

test('webhook: assinatura inválida, corpo adulterado, replay antigo e evento repetido', async () => {
  const u = await makeUser(ctx);
  const c = await recharge(ctx, u, 1100, { pay: false });
  const row = ctx.app.db.get('SELECT psp_txid FROM charges WHERE id=?', c.id);
  const raw = JSON.stringify({ event_id: 'evt-' + crypto.randomUUID(), type: 'pix.paid', txid: row.psp_txid, paid_total_cents: 1300 });
  const sig = signWebhook('dev-psp-secret', raw, clock.now());
  assert.equal((await ctx.call('POST', '/v1/webhooks/psp', { raw, headers: { 'x-tobus-signature': signWebhook('segredo-errado', raw, clock.now()) } })).status, 401);
  assert.equal((await ctx.call('POST', '/v1/webhooks/psp', { raw: raw.replace('1300', '9999'), headers: { 'x-tobus-signature': sig } })).status, 401, 'corpo adulterado');
  assert.equal((await ctx.call('POST', '/v1/webhooks/psp', { raw })).status, 401, 'sem assinatura');
  assert.equal((await ctx.call('POST', '/v1/webhooks/psp', { raw, headers: { 'x-tobus-signature': signWebhook('dev-psp-secret', raw, clock.now() - 10 * 60_000) } })).status, 401, 'timestamp velho (replay)');
  assert.equal((await bal(u)).balance_cents, 0);
  const ok = await ctx.call('POST', '/v1/webhooks/psp', { raw, headers: { 'x-tobus-signature': sig } });
  assert.equal(ok.json.outcome, 'credited');
  const again = await ctx.call('POST', '/v1/webhooks/psp', { raw, headers: { 'x-tobus-signature': sig } });
  assert.equal(again.json.outcome, 'replay');
  assert.equal((await bal(u)).balance_cents, 1100, 'não credita duas vezes');
});

test('valor pago diferente do cobrado NÃO credita (vai para conciliação)', async () => {
  const u = await makeUser(ctx);
  const c = await recharge(ctx, u, 2000, { pay: false });
  const r = await pspPay(ctx, c.id, 500);
  assert.equal(r.json.outcome, 'amount_mismatch');
  assert.equal((await bal(u)).balance_cents, 0);
  assert.equal(ctx.app.db.get('SELECT status FROM charges WHERE id=?', c.id).status, 'review');
});

test('pagamento DUPLICADO da mesma cobrança: credita 1x e devolve o 2º integralmente ao pagador', async () => {
  const u = await makeUser(ctx);
  const c = await recharge(ctx, u, 2000);
  const r = await pspPay(ctx, c.id, 2200);
  assert.equal(r.json.outcome, 'duplicate_payment');
  assert.equal((await bal(u)).balance_cents, 2000);
  const ref = ctx.app.db.get("SELECT * FROM refunds WHERE reason='dup' AND user_id=?", u.id);
  assert.equal(ref.status, 'paid'); assert.equal(ref.amount_cents, 2200);
});

test('Idempotency-Key: mesma chave = mesma cobrança; corpo diferente = 422; sem chave = 400', async () => {
  const u = await makeUser(ctx);
  const k = idemKey();
  const body = { amount_cents: 1000, method: 'pix' };
  const a = await ctx.call('POST', '/v1/recharges', { token: u.token, headers: { 'idempotency-key': k }, body });
  const b = await ctx.call('POST', '/v1/recharges', { token: u.token, headers: { 'idempotency-key': k }, body });
  assert.equal(a.json.id, b.json.id);
  assert.equal(ctx.app.db.get('SELECT COUNT(*) AS n FROM charges WHERE user_id=?', u.id).n, 1);
  assert.equal((await ctx.call('POST', '/v1/recharges', { token: u.token, headers: { 'idempotency-key': k }, body: { ...body, amount_cents: 2000 } })).status, 422);
  assert.equal((await ctx.call('POST', '/v1/recharges', { token: u.token, body })).json.error.code, 'idempotency_key_required');
});

test('regras de recarga: mínimo, valor fracionado/negativo/float, limite de saldo (R$ 275), cobranças abertas, cartão bloqueado', async () => {
  const u = await makeUser(ctx);
  const t = (b) => ctx.call('POST', '/v1/recharges', { token: u.token, headers: { 'idempotency-key': idemKey() }, body: b });
  assert.equal((await t({ amount_cents: 500, method: 'pix' })).json.error.code, 'below_minimum');
  assert.equal((await t({ amount_cents: 1050.5, method: 'pix' })).json.error.code, 'invalid_field', 'float rejeitado');
  assert.equal((await t({ amount_cents: -1000, method: 'pix' })).json.error.code, 'invalid_field');
  assert.equal((await t({ amount_cents: '1000', method: 'pix' })).json.error.code, 'invalid_field');
  assert.equal((await t({ amount_cents: 27501, method: 'pix' })).json.error.code, 'balance_limit');
  assert.equal((await t({ amount_cents: 27500, method: 'pix' })).status, 201, 'limite exato = 50 passagens');
  assert.equal((await t({ amount_cents: 600, method: 'pix' })).json.error.code, 'balance_limit', 'pendente reserva o limite');
  const u2 = await makeUser(ctx);
  await ctx.call('POST', `/v1/cards/${u2.card.id}/block`, { token: u2.token, headers: await stepup(ctx, u2, 'card.block'), body: { reason: 'temporary' } });
  const r = await ctx.call('POST', '/v1/recharges', { token: u2.token, headers: { 'idempotency-key': idemKey() }, body: { amount_cents: 1000, method: 'pix' } });
  assert.equal(r.json.error.code, 'card_not_active');
});

test('embarque: só validador autenticado debita; saldo insuficiente; replay do evento não debita 2x', async () => {
  const u = await makeUser(ctx);
  await recharge(ctx, u, 1100);
  const ev = crypto.randomUUID();
  const a = await board(ctx, val, u.number, { event: ev });
  assert.equal(a.json.decision, 'approved'); assert.equal(a.json.fare_cents, 550); assert.equal(a.json.balance_after_cents, 550);
  const rep = await board(ctx, val, u.number, { event: ev });
  assert.equal(rep.json.decision, 'approved'); assert.equal((await bal(u)).balance_cents, 550, 'replay não debita');
  assert.equal((await board(ctx, val, u.number)).json.decision, 'approved');
  const none = await board(ctx, val, u.number);
  assert.equal(none.json.decision, 'denied'); assert.equal(none.json.reason, 'insufficient_funds');
  assert.equal((await board(ctx, val, '5039999999999999')).json.reason, 'card_unknown');
  // usuário final não consegue debitar pelo app
  assert.equal((await ctx.call('POST', '/v1/validator/boardings', { token: u.token, body: { event_id: crypto.randomUUID(), card_number: u.number, line: '105', occurred_at: clock.now() } })).status, 401);
});

test('validador: assinatura inválida/timestamp velho/validador desconhecido => 401', async () => {
  const raw = JSON.stringify({ event_id: crypto.randomUUID(), card_number: '5039000000000001', line: '105', occurred_at: clock.now() });
  const call = (h) => ctx.call('POST', '/v1/validator/boardings', { raw, headers: h });
  assert.equal((await call({ 'x-validator-id': val.id, 'x-timestamp': String(clock.now()), 'x-signature': 'a'.repeat(64) })).status, 401);
  assert.equal((await call({ 'x-validator-id': 'val_000000000000', 'x-timestamp': String(clock.now()), 'x-signature': 'a'.repeat(64) })).status, 401);
  assert.equal((await call({})).status, 401);
});

test('tarifa por categoria: estudantil só após aprovação do backoffice (R$ 2,75); rural por linha', async () => {
  const u = await makeUser(ctx, { tipo: 'est' });
  await recharge(ctx, u, 1100);
  assert.equal((await board(ctx, val, u.number)).json.fare_cents, 550, 'antes da aprovação paga tarifa cheia');
  const adm = await adminSession(ctx, 'support');
  const list = (await ctx.call('GET', '/v1/admin/benefits', { token: adm.token })).json.items;
  const req = list.find((x) => x.user_id === u.id);
  const d = await ctx.call('POST', `/v1/admin/benefits/${req.id}/decision`, { token: adm.token, body: { decision: 'approve' } });
  assert.equal(d.status, 200);
  assert.equal((await board(ctx, val, u.number)).json.fare_cents, 275);
  assert.equal((await ctx.call('GET', '/v1/me', { token: u.token })).json.limits.max_balance_cents, 13750);
});

test('boardings: evento do futuro/antigo negado', async () => {
  const u = await makeUser(ctx); await recharge(ctx, u, 1100);
  assert.equal((await board(ctx, val, u.number, { at: clock.now() + 3_600_000 })).json.reason, 'event_in_future');
  assert.equal((await board(ctx, val, u.number, { at: clock.now() - 8 * 86_400_000 })).json.reason, 'event_too_old');
});

test('cartão: bloqueado/perdido recusa embarque; perdido/roubado NÃO desbloqueia; temporário desbloqueia', async () => {
  const u = await makeUser(ctx); await recharge(ctx, u, 1100);
  const blk = (reason) => ctx.call('POST', `/v1/cards/${u.card.id}/block`, { token: u.token, headers: stepupSync, body: { reason } });
  let stepupSync = await stepup(ctx, u, 'card.block');
  assert.equal((await blk('temporary')).status, 200);
  assert.equal((await board(ctx, val, u.number)).json.reason, 'card_blocked');
  assert.equal((await ctx.call('POST', `/v1/cards/${u.card.id}/unblock`, { token: u.token, headers: await stepup(ctx, u, 'card.unblock') })).json.status, 'active');
  stepupSync = await stepup(ctx, u, 'card.block'); assert.equal((await blk('stolen')).status, 200);
  const un = await ctx.call('POST', `/v1/cards/${u.card.id}/unblock`, { token: u.token, headers: await stepup(ctx, u, 'card.unblock') });
  assert.equal(un.json.error.code, 'card_must_be_replaced');
});

test('2ª via: taxa debitada no razão, cartão antigo cancelado, novo pendente de ativação; saldo preservado; idempotente', async () => {
  const u = await makeUser(ctx); await recharge(ctx, u, 2000);
  const k = idemKey();
  const go = () => ctx.call('POST', `/v1/cards/${u.card.id}/second-via`, { token: u.token, headers: { ...stepupH, 'idempotency-key': k }, body: { reason: 'lost' } });
  let stepupH = await stepup(ctx, u, 'card.second_via');
  const r = await go();
  assert.equal(r.status, 201); assert.equal(r.json.fee_cents, 1000); assert.equal(r.json.new_card.status, 'pending_activation');
  assert.equal((await bal(u)).balance_cents, 1000, '20,00 − 10,00');
  assert.equal((await board(ctx, val, u.number)).json.reason, 'card_cancelled', 'cartão antigo morto');
  const newNum = (await ctx.call('GET', `/v1/cards/${r.json.new_card.id}/number`, { token: u.token, headers: await stepup(ctx, u, 'card.reveal') })).json.number;
  assert.equal((await board(ctx, val, newNum)).json.reason, 'card_pending_activation');
  await ctx.call('POST', `/v1/cards/${r.json.new_card.id}/activate`, { token: u.token, headers: await stepup(ctx, u, 'card.activate') });
  assert.equal((await board(ctx, val, newNum)).json.decision, 'approved');
  const again = await ctx.call('POST', `/v1/cards/${u.card.id}/second-via`, { token: u.token, headers: { ...await stepup(ctx, u, 'card.second_via'), 'idempotency-key': idemKey() }, body: { reason: 'lost' } });
  assert.equal(again.json.error.code, 'card_not_replaceable', 'não cobra 2ª taxa pelo mesmo cartão');
});

test('2ª via com saldo insuficiente é recusada sem efeitos', async () => {
  const u = await makeUser(ctx);
  const r = await ctx.call('POST', `/v1/cards/${u.card.id}/second-via`, { token: u.token, headers: { ...await stepup(ctx, u, 'card.second_via'), 'idempotency-key': idemKey() }, body: { reason: 'lost' } });
  assert.equal(r.json.error.code, 'insufficient_funds');
  assert.equal((await ctx.call('GET', '/v1/cards', { token: u.token })).json.items[0].status, 'active');
});

test('reembolso: crédito não usado volta ao pagador, saldo e razão batem; 2º pedido da mesma recarga é barrado', async () => {
  const u = await makeUser(ctx);
  const c = await recharge(ctx, u, 2000);
  await board(ctx, val, u.number); // usa 5,50
  const r = await ctx.call('POST', '/v1/refunds', { token: u.token, headers: { ...await stepup(ctx, u, 'refund.create'), 'idempotency-key': idemKey() }, body: { charge_id: c.id, reason: 'des', recognized: true } });
  assert.equal(r.status, 201); assert.equal(r.json.status, 'paid');
  assert.equal(r.json.amount_cents, 1450, 'devolve só o NÃO usado (20,00 − 5,50), sem taxa');
  assert.equal((await bal(u)).balance_cents, 0);
  const dup = await ctx.call('POST', '/v1/refunds', { token: u.token, headers: { ...await stepup(ctx, u, 'refund.create'), 'idempotency-key': idemKey() }, body: { charge_id: c.id, reason: 'des', recognized: true } });
  assert.ok(['nothing_to_refund', 'charge_not_refundable'].includes(dup.json.error.code));
});

test('reembolso "crédito não chegou" quando o crédito JÁ foi lançado é negado (fim do duplo benefício)', async () => {
  const u = await makeUser(ctx);
  const c = await recharge(ctx, u, 2000);
  const r = await ctx.call('POST', '/v1/refunds', { token: u.token, headers: { ...await stepup(ctx, u, 'refund.create'), 'idempotency-key': idemKey() }, body: { charge_id: c.id, reason: 'nc', recognized: true } });
  assert.equal(r.json.error.code, 'credit_already_posted');
  assert.equal((await bal(u)).balance_cents, 2000);
});

test('reembolso "não reconheço": vai para análise, saldo fica RETIDO (não dá para gastar) até decisão humana', async () => {
  const u = await makeUser(ctx);
  const c = await recharge(ctx, u, 2000);
  const r = await ctx.call('POST', '/v1/refunds', { token: u.token, headers: { ...await stepup(ctx, u, 'refund.create'), 'idempotency-key': idemKey() }, body: { charge_id: c.id, reason: 'err', recognized: false } });
  assert.equal(r.json.status, 'analysis'); assert.equal(r.json.recommend_block_card, true);
  const b = await bal(u); assert.equal(b.held_cents, 2000); assert.equal(b.available_cents, 0);
  assert.equal((await board(ctx, val, u.number)).json.reason, 'insufficient_funds', 'retido não embarca');
  const adm = await adminSession(ctx, 'finance');
  const pending = (await ctx.call('GET', '/v1/admin/refunds', { token: adm.token })).json.items;
  assert.ok(pending.find((x) => x.id === r.json.id));
  const d = await ctx.call('POST', `/v1/admin/refunds/${r.json.id}/decision`, { token: adm.token, body: { decision: 'approve', include_fee: true } });
  assert.equal(d.json.status, 'paid'); assert.equal(d.json.amount_cents, 2200);
  const b2 = await bal(u); assert.equal(b2.balance_cents, 0); assert.equal(b2.held_cents, 0);
});

test('reembolso negado libera a retenção; papel sem permissão é barrado', async () => {
  const u = await makeUser(ctx);
  const c = await recharge(ctx, u, 2000);
  const r = await ctx.call('POST', '/v1/refunds', { token: u.token, headers: { ...await stepup(ctx, u, 'refund.create'), 'idempotency-key': idemKey() }, body: { charge_id: c.id, reason: 'err', recognized: false } });
  const sec = await adminSession(ctx, 'security');
  assert.equal((await ctx.call('POST', `/v1/admin/refunds/${r.json.id}/decision`, { token: sec.token, body: { decision: 'approve' } })).json.error.code, 'insufficient_role');
  const adm = await adminSession(ctx, 'support');
  assert.equal((await ctx.call('POST', `/v1/admin/refunds/${r.json.id}/decision`, { token: adm.token, body: { decision: 'deny', note: 'fraude' } })).json.status, 'denied');
  assert.deepEqual(await bal(u), { balance_cents: 2000, held_cents: 0, available_cents: 2000 });
});

test('reembolso: prazo de 30 dias e outro usuário não acessa a recarga', async () => {
  const u = await makeUser(ctx), o = await makeUser(ctx);
  const c = await recharge(ctx, u, 2000);
  const hdr = async (x) => ({ ...await stepup(ctx, x, 'refund.create'), 'idempotency-key': idemKey() });
  assert.equal((await ctx.call('POST', '/v1/refunds', { token: o.token, headers: await hdr(o), body: { charge_id: c.id, reason: 'des', recognized: true } })).status, 404);
  ctx.app.db.run('UPDATE charges SET paid_at=? WHERE id=?', clock.now() - 31 * 86_400_000, c.id);
  const r = await ctx.call('POST', '/v1/refunds', { token: u.token, headers: await hdr(u), body: { charge_id: c.id, reason: 'des', recognized: true } });
  assert.equal(r.json.error.code, 'refund_window_expired');
});

test('IDOR: usuário não lê/altera cartão ou recarga de outro', async () => {
  const a = await makeUser(ctx), b = await makeUser(ctx);
  const c = await recharge(ctx, a, 1100, { pay: false });
  assert.equal((await ctx.call('GET', `/v1/recharges/${c.id}`, { token: b.token })).status, 404);
  assert.equal((await ctx.call('POST', `/v1/recharges/${c.id}/cancel`, { token: b.token })).status, 404);
  assert.equal((await ctx.call('POST', `/v1/cards/${a.card.id}/block`, { token: b.token, headers: await stepup(ctx, b, 'card.block'), body: { reason: 'temporary' } })).status, 404);
  assert.equal((await ctx.call('GET', `/v1/cards/${a.card.id}/number`, { token: b.token, headers: await stepup(ctx, b, 'card.reveal') })).status, 404);
});

test('cartão: não vincula o mesmo número duas vezes; número inválido não vaza motivo', async () => {
  const a = await makeUser(ctx), b = await makeUser(ctx, { card: false });
  const r = await ctx.call('POST', '/v1/cards/bind', { token: b.token, body: { number: a.number } });
  assert.equal(r.json.error.code, 'card_unavailable');
  const r2 = await ctx.call('POST', '/v1/cards/bind', { token: b.token, body: { number: '1111222233334444' } });
  assert.equal(r2.json.error.code, 'card_unavailable', 'mesma mensagem: sem oráculo de cartões válidos');
});

test('INTEGRIDADE: razão encadeado confere, é imutável por triggers e detecta adulteração direta no banco', async () => {
  const chk = verifyLedger(ctx.app.db);
  assert.equal(chk.ok, true, JSON.stringify(chk.errors)); assert.ok(chk.checked > 10);
  assert.throws(() => ctx.app.db.run('UPDATE ledger SET amount_cents=999999 WHERE id=1'), /imutavel/);
  assert.throws(() => ctx.app.db.run('DELETE FROM ledger WHERE id=1'), /imutavel/);
  assert.throws(() => ctx.app.db.run('UPDATE audit_log SET action=\'x\' WHERE id=1'), /imutavel/);
  assert.throws(() => ctx.app.db.run('UPDATE accounts SET balance_cents=-1 WHERE rowid=1'), /CHECK/);
  // atacante com acesso ao arquivo remove os triggers e adultera: a cadeia de hash denuncia
  ctx.app.db.exec('DROP TRIGGER ledger_no_update');
  ctx.app.db.exec('UPDATE ledger SET amount_cents=amount_cents+100 WHERE id=2');
  assert.equal(verifyLedger(ctx.app.db).ok, false);
  const adm = await adminSession(ctx, 'security');
  assert.equal((await ctx.call('GET', '/v1/admin/integrity', { token: adm.token })).json.ledger.ok, false);
});
