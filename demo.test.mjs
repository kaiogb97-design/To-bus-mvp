import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, sleep } from './harness.mjs';

test('MODO DEMO: carrega os 9 módulos sem erro e a aritmética em centavos fecha', async () => {
  const a = loadApp({ cfg: { MODO_DEMO: true, API_URL: '' }, fetchImpl: () => { throw new Error('demo não deve usar rede'); } });
  assert.equal(a.run('addR(0.1,0.2)'), 0.3);
  assert.equal(a.run('addR(19.99,2)'), 21.99);
  assert.equal(a.run('calcRecarga(0).pct'), 0, 'sem divisão por zero');
  assert.equal(a.run('R(addR(5.5,2))'), 'R$ 7,50');
});

test('BUG DE FUSO corrigido: idade no dia exato do aniversário e datas inexistentes', async () => {
  const a = loadApp({ cfg: { MODO_DEMO: true }, fetchImpl: null });
  const r = a.run(`(()=>{const t=new Date(),pad=n=>String(n).padStart(2,'0'),ymd=(y,m,d)=>y+'-'+pad(m)+'-'+pad(d);
    const hoje=ymd(t.getFullYear()-12,t.getMonth()+1,t.getDate());
    const amanha=new Date(t.getFullYear()-12,t.getMonth(),t.getDate()+1); const am=ymd(amanha.getFullYear(),amanha.getMonth()+1,amanha.getDate());
    return {aniv:ageOf(hoje),antes:ageOf(am),inval:ageOf('2023-02-30'),lixo:ageOf('abc'),v1:validYmd('2024-02-29'),v2:validYmd('2023-02-29')}})()`);
  assert.equal(r.aniv, 12, 'no dia do aniversário já tem 12');
  assert.equal(r.antes, 11, 'um dia antes ainda tem 11');
  assert.ok(Number.isNaN(r.inval) && Number.isNaN(r.lixo));
  assert.equal(r.v1, true); assert.equal(r.v2, false);
});

test('PIN fraco: sequências, repetidos, anos, data de nascimento', async () => {
  const a = loadApp({ cfg: { MODO_DEMO: true }, fetchImpl: null });
  for (const p of ['1234', '0000', '2580', '1999', '4321']) assert.equal(a.run(`weakPin('${p}',{})`), true, p);
  assert.equal(a.run("weakPin('1503',{nasc:'1990-03-15'})"), true, 'DDMM do nascimento');
  assert.equal(a.run("weakPin('7391',{nasc:'1990-03-15'})"), false);
});

test('XSS: texto malicioso no histórico é escapado em "linha mais usada"', async () => {
  const a = loadApp({ cfg: { MODO_DEMO: true }, fetchImpl: null });
  const out = a.run(`(()=>{S.hist=[{t:'Embarque – Linha <img/src=x/onerror=alert(1)>',v:-5.5,k:'uso',ts:Date.now(),d:''}];let h='';try{h=String(insights())}catch(e){h='ERR '+e.message}return h})()`);
  assert.ok(!/<img/i.test(out), 'tag não pode aparecer crua: ' + out.slice(0, 200));
});

test('saveNow no modo servidor não grava saldo no aparelho; demo respeita cota', async () => {
  const a = loadApp({ cfg: { MODO_DEMO: false, API_URL: 'http://x' }, fetchImpl: () => { throw new Error('sem rede'); } });
  a.run("USER={oid:'abc',nome:'Teste da Silva',cpf:'1',tipo:'urb'};S=INIT();S.saldo=123;saveNow()");
  assert.equal([...a.ls.keys()].filter((k) => k.startsWith('tb_s_')).length, 0);
});

test('reembolso: não existe mais campo para "chave Pix" informada pelo usuário', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('../app/www/js/09-reembolso-segunda-via.js', 'utf8');
  assert.ok(!src.includes('Pix · E-mail') && src.includes('pagador original'));
});

test('cartão perdido/roubado: desbloquear leva para a 2ª via (regra igual à do servidor)', async () => {
  const a = loadApp({ cfg: { MODO_DEMO: true }, fetchImpl: null });
  a.run("S.motivo='Meu cartão foi roubado';flowDesb()");
  assert.equal(a.run('!!(S.flow&&S.flow.ok!==undefined)'), false, 'não entrou no fluxo de desbloqueio');
});
