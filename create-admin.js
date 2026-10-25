// Uso: npm run create-admin -- ops@empresa.com.br superadmin|finance|support|security
import { createApp } from '../src/app.js';
import { createAdmin } from '../src/services/admin.js';
const [email, role = 'support'] = process.argv.slice(2);
if (!email) { console.error('uso: create-admin <email> [role]'); process.exit(1); }
const app = createApp();
const a = await createAdmin(app, email, role);
console.log('\nADMIN CRIADO (anote AGORA; não será exibido novamente)\n');
console.log('e-mail :', a.email, '\npapel  :', a.role, '\nsenha  :', a.password, '\nTOTP   :', a.totp_secret, '\nURI    :', a.otpauth, '\n');
app.db.close();
