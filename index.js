import { createApp, listen, shutdown } from './app.js';
import { log } from './lib/logger.js';

const app = createApp();
const addr = await listen(app);
log('info', 'server.started', { host: addr.address, port: addr.port, env: app.cfg.env });
if (!app.cfg.isProd) log('warn', 'server.dev_mode', { msg: 'Chaves de desenvolvimento em uso. NUNCA exponha este modo à internet.' });
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { if (closing) return; closing = true; log('info', 'server.stopping', { sig }); await shutdown(app); process.exit(0); });
}
process.on('unhandledRejection', (e) => { log('error', 'unhandledRejection', { err: String(e?.message || e) }); });
