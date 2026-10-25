# Modelo de segurança
**Princípio:** o aplicativo é território hostil. Nada que afete dinheiro, identidade ou estado do cartão é decidido no celular.

## Controles implementados (todos cobertos por teste)
- Senha e PIN: scrypt (N=2¹⁵) + *pepper* fora do banco; bloqueio progressivo **persistido**; resposta única (sem enumeração) e tempo equalizado.
- Sessões: token opaco (guardado só o SHA-256), access 15 min, refresh com rotação e **detecção de reuso**, vínculo ao dispositivo, dispositivo novo exige OTP.
- Step-up: PIN ou biometria **verificados no servidor** (ECDSA P-256, nonce de uso único assinando `nonce.escopo`), token de uso único por escopo.
- Dinheiro: centavos inteiros; razão **imutável** (triggers) e **encadeado por hash**; saldo ≥ 0 e retido ≤ saldo por `CHECK`; idempotência por chave; crédito só por webhook assinado com valor exato; pagamento duplicado devolvido; reembolso com retenção e devolução ao pagador original; um pedido ativo por cobrança (índice único parcial).
- Embarque: somente validador autenticado por HMAC; evento único (replay inofensivo).
- Dados pessoais: AES-256-GCM por campo (AAD por contexto), chaves rotacionáveis, índice cego HMAC; CPF/e-mail/cartão nunca em claro no banco, em log ou no outbox.
- LGPD: consentimento versionado, exportação, anonimização, retenção do razão.
- HTTP: headers de segurança, CORS por allowlist (`null` e `*` proibidos), JSON estrito com lista branca de campos (anti *mass assignment*), limite de corpo, timeouts, rate limit por IP/conta/alvo.
- Backoffice: senha + TOTP (sem reuso), RBAC, sessão curta, tudo auditado. Auditoria imutável e encadeada.
- Produção **falha fechada**: sem segredos fortes/sem origens válidas/com mock, não sobe.

## O que este servidor NÃO resolve sozinho (precisa de ação fora dele)
1. **TLS e borda**: terminar TLS (Caddy/ALB), WAF e proteção DDoS (Cloudflare/AWS Shield) na frente.
2. **Cofre de segredos/KMS/HSM**: as 5 chaves devem vir de um cofre com controle de acesso e rotação; backup **separado** das chaves.
3. **Vínculo do cartão ao CPF** no sistema do operador (ver `INTEGRATIONS.md`) — sem isso, qualquer pessoa vincula um cartão alheio.
4. **Aprovação humana de benefícios** (estudante/rural/idoso) com comprovante — o servidor já impede autodeclaração, mas precisa de operador e fonte de dados (escola/UNE/Prefeitura).
5. **Aplicativo**: remover `debuggable`/`allowBackup`, assinar com chave de release, `WebViewAssetLoader`, `FLAG_SECURE`, chave biométrica no Keystore, *Play Integrity* (diagnóstico §Android).
6. **Alta disponibilidade**: SQLite = 1 nó. Para HA: PostgreSQL gerenciado Multi-AZ + Redis (rate limit) + 2+ instâncias.
7. **Conformidade regulatória** de guarda de recursos de terceiros / arranjo de pagamento — requer parecer jurídico/BCB (não é decisão técnica).
8. **Pentest independente** antes de abrir ao público.
