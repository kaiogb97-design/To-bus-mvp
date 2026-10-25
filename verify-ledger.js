// Verifica a integridade do razão e da auditoria. Rode diariamente (cron) e alerte se sair código ≠ 0.
import { createApp } from '../src/app.js';
import { verifyLedger } from '../src/core/ledger.js';
import { verifyAudit } from '../src/core/audit.js';
const app = createApp();
const l = verifyLedger(app.db), a = verifyAudit(app.db);
console.log(JSON.stringify({ ledger: { ok: l.ok, checked: l.checked }, audit: { ok: a.ok, checked: a.checked }, errors: [...l.errors, ...a.errors].slice(0, 20) }, null, 2));
app.db.close();
process.exit(l.ok && a.ok ? 0 : 2);
