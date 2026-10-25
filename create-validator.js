// Uso: npm run create-validator -- "Ônibus 105 / validador 01"
import { createApp } from '../src/app.js';
import { createValidator } from '../src/services/boarding.js';
const name = process.argv[2];
if (!name) { console.error('uso: create-validator "<nome>"'); process.exit(1); }
const app = createApp();
const v = createValidator(app, name);
console.log('\nVALIDADOR CRIADO (o segredo só aparece agora)\nid     :', v.id, '\nsegredo:', v.secret, '\n');
app.db.close();
