# Integrações a contratar/implementar (substituir os mocks)
Interfaces em `src/adapters/`. Implemente o mesmo contrato e selecione por variável (`PSP_PROVIDER`, …).

## PSP / Pix (`adapters/psp.js`)
`createCharge({txid,totalCents,expiresInSec}) → {payload}` (BR Code dinâmico; `txid` gerado pelo servidor, idempotente)
· `refund({txid,refundId,amountCents})` (devolução ao pagador original) · `verifyWebhook(headers,rawBody,secrets,now)`.
Provedores comuns: Efí, Mercado Pago, Asaas, Pagar.me. Cada um tem seu esquema de autenticação do webhook (mTLS da API Pix
do BC, HMAC, token) — implemente-o em `verifyWebhook` e **mantenha a regra**: creditar só com valor exato e evento único.
Faça **conciliação diária** (extrato do PSP × tabela `charges`/`webhook_events`) para pegar `amount_mismatch` e pagamentos sem evento.

## Bilhetagem (`adapters/bilhetagem.js`)
`verifyCard(number, userId)` deve conferir **que o cartão existe e pertence ao CPF do titular** no sistema do operador
(número impresso no cartão NÃO é segredo: sem essa checagem, qualquer um vincula o cartão de outra pessoa).
`issueCard` / `cancelCard` para 2ª via. Defina com o operador: modelo **account-based** (saldo no servidor, validador consulta/
debita via `/v1/validator/boardings`) ou **card-based** (saldo no cartão; recarga remota entra em fila e é gravada no próximo toque).
O servidor hoje implementa account-based; card-based exige fila de "crédito pendente" + confirmação do operador.

## Notificações (`adapters/notify.js`)
`NOTIFY_PROVIDER=http` envia JSON `{channel,to,template,vars}` a um gateway interno (SES / Zenvia / Twilio / FCM).
Templates usados: otp, registration_attempt, account_locked, pin_locked, pin_changed, password_changed, contact_changed.
