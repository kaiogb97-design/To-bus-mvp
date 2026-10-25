# Operação
- **Backup**: `scripts/backup.sh` (VACUUM INTO + age + bucket). Teste a restauração mensalmente. Retenção local 14 dias.
- **Integridade**: `scripts/verify-ledger.js` diário; código de saída ≠ 0 ⇒ incidente de segurança (adulteração do razão/auditoria).
- **Rotação de chave de dados**: adicione `DATA_KEY_K2`, mude `DATA_KEY_ID=k2` (novos dados usam k2; os antigos seguem legíveis com k1). Reencriptar em lote e só então aposentar k1.
- **Rotação do segredo do PSP**: `PSP_WEBHOOK_SECRETS=novo,antigo` → troque no PSP → remova o antigo.
- **Monitoramento**: alertar em `webhook.bad_signature`, `session.refresh_reuse_detected`, `login.locked` em rajada, `amount_mismatch`, 5xx, latência p95, falha de backup.
- **Resposta a incidente**: revogar sessões (`UPDATE sessions SET revoked_at…`), girar `PASSWORD_PEPPER` invalida todas as senhas (força reset), suspender usuário em `/v1/admin/users/:id/suspend`.
- **Escala**: várias instâncias exigem PostgreSQL e Redis (rate limit/lockouts em memória hoje).
