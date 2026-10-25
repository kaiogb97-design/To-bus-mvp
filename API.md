# API v1 — resumo
Base: `https://api.SEU-DOMINIO.com.br`. JSON. Valores **sempre em centavos inteiros**. Erros: `{"error":{"code","message","request_id"}}`.
Autenticação: `Authorization: Bearer tb_at_…` (15 min). `X-StepUp: tb_su_…` (uso único, 120 s, por escopo) nas operações sensíveis.
`Idempotency-Key` (16–64 chars) obrigatório em criação de recarga, reembolso e 2ª via.

| Método e rota | Auth | Observações |
|---|---|---|
| POST `/v1/auth/register` | — | Devolve 202 + `ticket` (idêntico se CPF/e-mail já existir). OTP por e-mail e SMS |
| POST `/v1/auth/register/verify` | — | `{ticket,email_code,phone_code,device}` → cria conta e sessão |
| POST `/v1/auth/login` | — | `{id,password,device,otp?}`; dispositivo novo → `device_verification_required` |
| POST `/v1/auth/refresh` | — | Rotação; reuso derruba a família de sessões |
| POST `/v1/auth/logout[?all=1]` | user | |
| POST `/v1/auth/password/forgot` · `/reset` | — | Exige código de e-mail **e** SMS |
| POST `/v1/stepup/challenge` · `/v1/stepup` | user | PIN ou biometria (ECDSA P-256 assinando `<nonce>.<scope>`) |
| POST `/v1/stepup/biometric/enroll` | user+stepup `biometric.enroll` | Registra chave pública do Keystore |
| GET `/v1/me` · `/me/statement` · `/me/boardings` | user | Extrato vem do razão, paginado por `before` |
| PATCH `/v1/me/address` | user+stepup `profile.edit` | |
| POST `/v1/me/contact` → `/me/contact/confirm` | user(+stepup) | Prova de posse do novo e-mail/celular |
| POST `/v1/me/pin` | user | PIN atual + novo |
| GET `/v1/me/export` · DELETE `/v1/me` | user+stepup | LGPD: exportar / anonimizar (saldo deve ser 0) |
| GET `/v1/pricing` | user | tarifa, taxa, limites |
| POST `/v1/benefits` | user | Solicita categoria estudantil/rural (aprovação humana) |
| GET `/v1/cards` · POST `/v1/cards/bind` | user | |
| POST `/v1/cards/:id/block` · `/unblock` · `/activate` · GET `/number` | user+stepup | perdido/roubado = terminal |
| POST `/v1/cards/:id/second-via` | user+stepup+idem | taxa no razão, cartão novo `pending_activation` |
| POST `/v1/recharges` · GET `/v1/recharges[/:id]` · POST `/:id/cancel` | user (+idem) | Pix; crédito **só** via webhook |
| POST `/v1/refunds` · GET `/v1/refunds` | user+stepup+idem | devolução ao pagador original |
| POST `/v1/webhooks/psp` | HMAC | `X-Tobus-Signature: t=<ms>,v1=<hmac(t.corpo)>`; ±5 min; evento único |
| POST `/v1/validator/boardings` | HMAC do validador | `X-Validator-Id`, `X-Timestamp`, `X-Signature=hmac(ts.POST.path.sha256(corpo))` |
| POST `/v1/admin/login` | senha+TOTP | |
| GET/POST `/v1/admin/refunds`, `/benefits`, `/users`, `/integrity`, `/validators` | admin (RBAC) | |
