// Gera os segredos (32 bytes, base64). Guarde no cofre (AWS Secrets Manager / GCP Secret Manager / Vault).
// NUNCA coloque em repositório. PERDER DATA_KEY = PERDER os dados pessoais (são irrecuperáveis).
import crypto from 'node:crypto';
const k = () => crypto.randomBytes(32).toString('base64');
console.log(`DATA_KEY_ID=k1\nDATA_KEY_K1=${k()}\nINDEX_KEY=${k()}\nPASSWORD_PEPPER=${k()}\nOTP_KEY=${k()}\nVALIDATOR_SECRET_KEY=${k()}\nPSP_WEBHOOK_SECRETS=${crypto.randomBytes(24).toString('hex')}`);
