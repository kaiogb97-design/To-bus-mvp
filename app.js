import http from 'node:http';
import { Db, migrate } from './db.js';
import { loadConfig } from './config.js';
import { RateLimiter } from './lib/ratelimit.js';
import { AppError, bad, notFound } from './lib/errors.js';
import { log, setLogLevel } from './lib/logger.js';
import { blindIndex, uuid } from './lib/crypto.js';
import { createPsp } from './adapters/psp.js';
import { createBilhetagem } from './adapters/bilhetagem.js';
import { createNotifier } from './adapters/notify.js';
import * as Auth from './services/auth.js';
import * as Step from './services/stepup.js';
import * as Cards from './services/cards.js';
import * as Rech from './services/recharges.js';
import * as Refunds from './services/refunds.js';
import * as Board from './services/boarding.js';
import * as Prof from './services/profile.js';
import * as Adm from './services/admin.js';
import { requestBenefit } from './services/benefits.js';
import { withIdempotency } from './services/common.js';

export function createApp(overrides = {}) {
  const cfg = { ...loadConfig(), ...(overrides.cfg || {}) };
  setLogLevel(cfg.logLevel);
  const db = overrides.db || new Db(cfg.dbPath);
  migrate(db);
  const app = {
    cfg, db, limiter: new RateLimiter(),
    psp: overrides.psp || createPsp(cfg), bilhetagem: overrides.bilhetagem || createBilhetagem(cfg), notifier: overrides.notifier || createNotifier(cfg),
    helpers: { blindIndex: (v, l) => blindIndex(v, l, cfg) },
  };
  app.routes = buildRoutes(app);
  app.server = http.createServer((req, res) => handle(app, req, res));
  // Timeouts contra Slowloris / conexões presas
  app.server.headersTimeout = 15_000; app.server.requestTimeout = 30_000; app.server.keepAliveTimeout = 5_000; app.server.maxRequestsPerSocket = 200;
  return app;
}

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', pragma: 'no-cache',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'cross-origin-resource-policy': 'same-site', 'permissions-policy': 'geolocation=(), camera=(), microphone=()',
};

function clientIp(app, req) {
  if (app.cfg.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // último salto = o que o proxy de borda realmente viu (não forjável pelo cliente)
  }
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max * 8) { req.destroy(); return; }          // abuso grosseiro: derruba a conexão
      if (over) return;                                        // descarta o excedente (permite responder 413 com limpeza)
      if (size > max) { over = true; reject(new AppError(413, 'payload_too_large', 'Corpo da requisição muito grande.')); } else chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { if (!over) reject(e); });
  });
}

function send(res, status, body, extra = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...SEC_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(payload);
}

function cors(app, req, res) {
  const o = req.headers.origin;
  if (!o) return {};
  if (app.cfg.allowedOrigins.includes(o)) {
    return { 'access-control-allow-origin': o, vary: 'Origin', 'access-control-allow-headers': 'authorization,content-type,idempotency-key,x-stepup', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-max-age': '600' };
  }
  return { vary: 'Origin' };
}

async function handle(app, req, res) {
  const rid = uuid(), t0 = Date.now(), ip = clientIp(app, req);
  const corsH = cors(app, req, res);
  const out = (status, body, extra) => send(res, status, body, { 'x-request-id': rid, ...corsH, ...extra });
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return out(204);
    const g = app.limiter.hit('g:' + ip, 300, 60_000);
    if (!g.ok) throw new AppError(429, 'rate_limited', 'Muitas requisições.', { retry_after_sec: g.retryAfterSec });
    const route = app.routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) throw notFound('route_not_found', 'Rota não encontrada.');
    const m = route.re.exec(url.pathname);
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let raw = '', body = {};
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      raw = await readBody(req, route.raw === 'webhook' ? app.cfg.webhookMaxBodyBytes : app.cfg.maxBodyBytes);
      if (raw.length) {
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new AppError(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
        if (!route.raw) { try { body = JSON.parse(raw); } catch { throw bad('invalid_json', 'JSON inválido.'); } }
      }
    }
    const ctx = { req, res, ip, params, query: Object.fromEntries(url.searchParams), body, raw, rid };
    if (route.auth === 'user') Object.assign(ctx, Auth.authenticate(app, req));
    if (route.auth === 'admin') ctx.admin = Adm.authAdmin(app, req);
    if (route.stepup) Step.requireStepup(app, ctx, req, route.stepup);
    const r = await route.handler(ctx);
    const status = r && r.__status ? r.status : 200;
    const payload = r && r.__status ? r.body : r;
    out(status, payload);
    log('info', 'http', { rid, m: req.method, p: route.name, s: status, ms: Date.now() - t0 });
  } catch (e) {
    if (e instanceof AppError) {
      const extra = e.extra?.retry_after_sec ? { 'retry-after': String(e.extra.retry_after_sec) } : {};
      out(e.status, { error: { code: e.code, message: e.message, request_id: rid, ...(e.extra || {}) } }, extra);
      log('info', 'http', { rid, m: req.method, s: e.status, err: e.code, ms: Date.now() - t0 });
    } else {
      log('error', 'unhandled', { rid, err: e.message, stack: e.stack?.split('\n').slice(0, 4).join(' | ') });
      out(500, { error: { code: 'internal_error', message: 'Erro interno. Tente novamente.', request_id: rid } }); // nunca vaza detalhes
    }
  }
}

const created = (body) => ({ __status: true, status: 201, body });
function buildRoutes(app) {
  const R = [];
  const add = (method, path, opts, handler) => {
    const keys = []; const re = new RegExp('^' + path.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    R.push({ method, re, keys, name: path, handler, ...opts });
  };
  const U = { auth: 'user' }, A = { auth: 'admin' };
  add('GET', '/healthz', {}, () => ({ status: 'ok' }));
  add('GET', '/readyz', {}, () => { app.db.get('SELECT 1 AS x'); return { status: 'ready' }; });
  // Autenticação
  add('POST', '/v1/auth/register', {}, async (c) => ({ __status: true, status: 202, body: await Auth.register(app, c.body, c.ip) }));
  add('POST', '/v1/auth/register/verify', {}, (c) => Auth.verifyRegistration(app, c.body, c.ip).then(created));
  add('POST', '/v1/auth/login', {}, (c) => Auth.login(app, c.body, c.ip));
  add('POST', '/v1/auth/refresh', {}, (c) => Auth.refresh(app, c.body, c.ip));
  add('POST', '/v1/auth/logout', U, (c) => { Auth.logout(app, c.session, c.query.all === '1'); return { status: 'logged_out' }; });
  add('POST', '/v1/auth/password/forgot', {}, async (c) => ({ __status: true, status: 202, body: await Auth.forgotPassword(app, c.body, c.ip) }));
  add('POST', '/v1/auth/password/reset', {}, (c) => Auth.resetPassword(app, c.body, c.ip));
  // Step-up
  add('POST', '/v1/stepup/challenge', U, (c) => Step.challenge(app, c));
  add('POST', '/v1/stepup', U, (c) => Step.issueStepup(app, c, c.body, c.ip));
  add('POST', '/v1/stepup/biometric/enroll', { ...U, stepup: 'biometric.enroll' }, (c) => Step.enrollBiometric(app, c, c.body, c.ip));
  // Perfil
  add('GET', '/v1/me', U, (c) => Prof.me(app, c.user));
  add('GET', '/v1/me/statement', U, (c) => Prof.statement(app, c.user, c.query));
  add('GET', '/v1/me/boardings', U, (c) => ({ items: Prof.boardingsList(app, c.user) }));
  add('PATCH', '/v1/me/address', { ...U, stepup: 'profile.edit' }, (c) => Prof.updateAddress(app, c.user, c.body, c.ip));
  add('POST', '/v1/me/contact', { ...U, stepup: 'profile.edit' }, (c) => Prof.startContactChange(app, c.user, c.body, c.ip));
  add('POST', '/v1/me/contact/confirm', U, (c) => Prof.confirmContactChange(app, c.user, c.body, c.ip));
  add('POST', '/v1/me/pin', U, (c) => Step.changePin(app, c, c.body, c.ip));
  add('GET', '/v1/me/export', { ...U, stepup: 'data.export' }, (c) => Prof.exportData(app, c.user, c.ip));
  add('DELETE', '/v1/me', { ...U, stepup: 'account.delete' }, (c) => Prof.deleteAccount(app, c.user, c.ip));
  add('GET', '/v1/pricing', U, (c) => Rech.pricing(app, c.user));
  add('POST', '/v1/benefits', U, (c) => created(requestBenefit(app, c.user, c.body)));
  // Cartões
  add('GET', '/v1/cards', U, (c) => ({ items: Cards.listCards(app, c.user) }));
  add('POST', '/v1/cards/bind', U, async (c) => created(Cards.cardView(await Cards.bindCard(app, c.user.id, String(c.body.number ?? '')))));
  add('POST', '/v1/cards/request', U, async (c) => created(await Cards.requestCard(app, c.user, c.ip)));
  add('POST', '/v1/cards/:id/block', { ...U, stepup: 'card.block' }, (c) => Cards.blockCard(app, c.user, c.params.id, c.body, c.ip));
  add('POST', '/v1/cards/:id/unblock', { ...U, stepup: 'card.unblock' }, (c) => Cards.unblockCard(app, c.user, c.params.id, c.ip));
  add('POST', '/v1/cards/:id/activate', { ...U, stepup: 'card.activate' }, (c) => Cards.activateCard(app, c.user, c.params.id, c.ip));
  add('GET', '/v1/cards/:id/number', { ...U, stepup: 'card.reveal' }, (c) => Cards.revealNumber(app, c.user, c.params.id, c.ip));
  add('POST', '/v1/cards/:id/second-via', { ...U, stepup: 'card.second_via' }, async (c) => {
    const r = await withIdempotency(app, c.user.id, c.req.headers['idempotency-key'], 'second-via:' + c.params.id, c.body, async () => ({ status: 201, body: await Cards.secondVia(app, c.user, c.params.id, c.body, c.ip) }));
    return created(r.body);
  });
  // Recargas
  add('POST', '/v1/recharges', U, async (c) => { const r = await withIdempotency(app, c.user.id, c.req.headers['idempotency-key'], 'recharge', c.body, () => Rech.createRecharge(app, c.user, c.body)); return { __status: true, status: r.status, body: r.body }; });
  add('GET', '/v1/recharges', U, (c) => ({ items: Rech.listRecharges(app, c.user) }));
  add('GET', '/v1/recharges/:id', U, (c) => Rech.getRecharge(app, c.user, c.params.id));
  add('POST', '/v1/recharges/:id/cancel', U, (c) => Rech.cancelRecharge(app, c.user, c.params.id));
  // Reembolsos
  add('POST', '/v1/refunds', { ...U, stepup: 'refund.create' }, async (c) => { const r = await withIdempotency(app, c.user.id, c.req.headers['idempotency-key'], 'refund', c.body, async () => ({ status: 201, body: await Refunds.createRefund(app, c.user, c.body, c.ip) })); return created(r.body); });
  add('GET', '/v1/refunds', U, (c) => ({ items: Refunds.listRefunds(app, c.user) }));
  // Integrações máquina-a-máquina
  add('POST', '/v1/webhooks/psp', { raw: 'webhook' }, (c) => Rech.handlePspWebhook(app, c.req.headers, c.raw));
  add('POST', '/v1/validator/boardings', { raw: 'validator' }, (c) => {
    const v = Board.authValidator(app, c.req.headers, '/v1/validator/boardings', c.raw);
    let b; try { b = JSON.parse(c.raw); } catch { throw bad('invalid_json', 'JSON inválido.'); }
    return Board.recordBoarding(app, v, b);
  });
  // Backoffice
  add('POST', '/v1/admin/login', {}, (c) => Adm.adminLogin(app, c.body, c.ip));
  add('GET', '/v1/admin/refunds', A, (c) => ({ items: Adm.listRefundsAdmin(app, c.admin, c.query.status || 'analysis') }));
  add('POST', '/v1/admin/refunds/:id/decision', A, (c) => { Adm.requirePerm(c.admin, 'refunds'); return Refunds.decideRefund(app, c.admin, c.params.id, c.body, c.ip); });
  add('GET', '/v1/admin/benefits', A, (c) => ({ items: Adm.listBenefits(app, c.admin) }));
  add('POST', '/v1/admin/benefits/:id/decision', A, (c) => Adm.decideBenefit(app, c.admin, c.params.id, c.body, c.ip));
  add('GET', '/v1/admin/users', A, (c) => Adm.lookupUser(app, c.admin, c.query.cpf || ''));
  add('POST', '/v1/admin/users/:id/suspend', A, (c) => Adm.suspendUser(app, c.admin, c.params.id, c.ip));
  add('GET', '/v1/admin/integrity', A, (c) => Adm.integrity(app, c.admin));
  add('POST', '/v1/admin/validators', A, (c) => created(Adm.newValidator(app, c.admin, c.body, c.ip)));
  return R;
}

export function listen(app) {
  return new Promise((resolve) => app.server.listen(app.cfg.port, app.cfg.host, () => resolve(app.server.address())));
}
export async function shutdown(app) {
  await new Promise((r) => app.server.close(r));
  app.db.close();
}
