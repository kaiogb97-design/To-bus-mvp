import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, sleep } from './harness.mjs';
import { boot, makeUser, recharge, pspPay, newValidator, board, PASSWORD, PIN } from '../server/test/helpers.js';

let srv, val;
before(async () => { srv = await boot(); val = newValidator(srv); });
after(async () => { await srv.close(); });
const until = async (f, ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(25); } return false; };

async function loggedIn() {
  const u = await makeUser(srv);
  const a = loadApp({ cfg: { MODO_DEMO: false, API_URL: srv.base, TERMS_VERSION: '2026-10' }, fetchImpl: fetch });
  a.run(`AU={d:{lg:${JSON.stringify(u.email)},ls:${JSON.stringify(PASSWORD)}},s:0}`);
  a.answer(() => ({ c: srv.otp('email') }));          // dispositivo novo → código por e-mail
  a.run('doLogin()');
  assert.ok(await until(() => a.run('!!(USER&&USER.oid&&S&&S.hist)') && a.run('USER.oid') === u.id), 'login concluiu e montou o estado');
  await sleep(100);
  return { u, a, T: (c) => a.run(c) };
}

test('login → estado vem do servidor; nada financeiro vai para o aparelho', async () => {
  const { u, a, T } = await loggedIn();
  assert.equal(T('S.saldo'), 0);
  assert.equal(T('C.final'), u.number.slice(-4));
  assert.equal(T('USER.nome'), 'Maria Aparecida Souza');
  assert.equal(T('C.max'), 275, 'limite vem do servidor');
  T('render()');                                       // renderiza as telas reais com o estado real
  for (const tab of ['home', 'cart', 'hist', 'perf']) T(`S.tab='${tab}';render()`);
  assert.deepEqual([...a.ls.keys()].filter((k) => k !== 'tb_dev' && k !== 'tb_rem'), [], 'localStorage só tem o id do dispositivo');
  a.stop();
});

test('recarga Pix: cobrança real, polling, saldo só sobe após o servidor confirmar', async () => {
  const { u, a, T } = await loggedIn();
  T("S.flow={step:3,v:20,pay:'Pix',qn:0};pay()");
  assert.ok(await until(() => T('!!(S.flow&&S.flow.charge)')), 'cobrança criada');
  assert.match(T('S.flow.charge.pix_payload'), /^000201/);
  assert.equal(T('S.saldo'), 0, 'criar cobrança não credita');
  const id = T('S.flow.charge.id');
  const rows = srv.app.db.all('SELECT COUNT(*) AS n FROM charges WHERE user_id=?', u.id); assert.equal(rows[0].n, 1);
  T('pay()');                                          // toque duplo reaproveita a mesma Idempotency-Key? (flow.busy=false aqui) → mesma cobrança
  await sleep(300);
  assert.equal(srv.app.db.get('SELECT COUNT(*) AS n FROM charges WHERE user_id=?', u.id).n, 1, 'idempotência: não cria 2ª cobrança');
  await pspPay(srv, id, 2200);
  assert.ok(await until(() => T('S.saldo') === 20, 9000), 'saldo atualizado após webhook');
  assert.equal(T('S.flow.step'), 5);
  assert.equal(T("S.hist[0].k"), 'rec');
  a.stop();
});

test('bloquear com PIN verificado no servidor: PIN errado não passa; certo bloqueia; desbloqueio temporário', async () => {
  const { u, a, T } = await loggedIn();
  T('S.flow={m:3};gate0=0');
  a.answer({ pin: '0001' }, { pin: PIN });             // 1ª tentativa errada, 2ª certa
  T('bio(doBloq)');
  assert.ok(await until(() => T('S.ativo') === false), 'cartão bloqueado');
  assert.equal(srv.app.db.get('SELECT status,block_reason FROM cards WHERE user_id=?', u.id).block_reason, 'temporary');
  assert.match(T('S.motivo'), /temporariamente/);
  T('flowDesb()');
  a.answer({ pin: PIN });
  T('bio(doDesb)');
  assert.ok(await until(() => T('S.ativo') === true), 'desbloqueado');
  a.stop();
});

test('roubado: app e servidor concordam que não desbloqueia; 2ª via cobra a taxa e deixa o cartão novo para ativar', async () => {
  const { u, a, T } = await loggedIn();
  await recharge(srv, u, 2000);              // outra sessão (a do cadastro) gera a recarga; o app só observa
  T('S.flow={m:1}');
  a.answer({ pin: PIN }); T('bio(doBloq)');
  assert.ok(await until(() => T('S.ativo') === false));
  T('flowDesb()');
  assert.equal(T('!!(S.flow&&S.flow.ok!==undefined)'), false, 'não abre o fluxo de desbloqueio');
  T("M2='Roubo'"); a.answer({ pin: PIN }); T('bio(do2via)');
  assert.ok(await until(() => T('S.seg2') === true), '2ª via registrada');
  assert.equal(srv.app.db.get('SELECT balance_cents AS b FROM accounts WHERE user_id=?', u.id).b, 1000, '20,00 − taxa 10,00');
  assert.equal(srv.app.db.get("SELECT status FROM cards WHERE user_id=? AND status<>'cancelled'", u.id).status, 'pending_activation');
  a.stop();
});

test('embarque no validador aparece no extrato do app; app não consegue debitar sozinho', async () => {
  const { u, a, T } = await loggedIn();
  await recharge(srv, u, 1100);
  await board(srv, val, u.number, { line: '105' });
  await T('SrvApi.me().then(()=>0)');
  T('embarcar(105)'); T('tap()');                      // botões do protótipo foram neutralizados
  assert.equal(srv.app.db.get('SELECT balance_cents AS b FROM accounts WHERE user_id=?', u.id).b, 550, 'só o validador debitou');
  a.stop();
});

test('logout encerra a sessão no servidor e zera o estado', async () => {
  const { u, a, T } = await loggedIn();
  const before = srv.app.db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND revoked_at IS NULL', u.id).n;
  T('logout()');
  assert.ok(await until(() => srv.app.db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND revoked_at IS NULL', u.id).n < before), 'sessão do app revogada no servidor');
  a.stop();
});


test('cadastro pelo app: OTP e-mail+SMS, cartão de 16 dígitos, estudantil fica pendente', async () => {
  const a = loadApp({ cfg: { MODO_DEMO: false, API_URL: srv.base, TERMS_VERSION: '2026-10' }, fetchImpl: fetch });
  srv.app.limiter.reset();
  const cpf = (await import('../server/test/helpers.js')).validCpf(246813579);
  a.run(`AU={s:3,d:{nome:'joão da silva',cpf:'${cpf}',nasc:'1991-07-20',tel:'(34) 99888-7766',email:'joao.novo@exemplo.com.br',cep:'38010-000',rua:'Rua A',num:'5',bairro:'Centro',tp:'est',tc:'info',fin:'5039999900001111',sn:'Cafe!Roxo#47',sc:'Cafe!Roxo#47',pin:'7391',tm:true}}`);
  a.answer(() => ({ e: srv.otp('email'), p: srv.otp('sms') }));
  a.run('nextCad()');
  assert.ok(await until(() => a.run('!!(USER&&USER.oid)')), 'conta criada e sessão iniciada');
  const row = srv.app.db.get("SELECT u.category, (SELECT status FROM benefit_requests b WHERE b.user_id=u.id) AS br FROM users u ORDER BY created_at DESC LIMIT 1");
  assert.equal(row.category, 'urb'); assert.equal(row.br, 'pending');
  assert.equal(a.run('C.final'), '1111');
  assert.equal(a.run('USER.tipo'), 'urb', 'desconto não vale por autodeclaração');
  a.stop();
});

test('reembolso pelo app: crédito não usado volta ao pagador; PIN conferido no servidor', async () => {
  const { u, a, T } = await loggedIn();
  const c = await recharge(srv, u, 2000);
  await T('SrvApi.me().then(()=>0)');
  a.answer({ m: '2', r: 'S' }, { pin: PIN });
  T(`rbPick('${c.id}')`);
  assert.ok(await until(() => srv.app.db.get('SELECT status FROM refunds WHERE user_id=?', u.id)?.status === 'paid'), 'reembolso pago');
  assert.equal(srv.app.db.get('SELECT balance_cents AS b FROM accounts WHERE user_id=?', u.id).b, 0);
  a.stop();
});
