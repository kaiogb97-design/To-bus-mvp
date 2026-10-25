# To Bus — Servidor seguro

API do aplicativo To Bus (recarga por Pix, saldo, cartão, embarque por validador, reembolso, backoffice).
**Node 22+, zero dependências externas** (somente módulos nativos: `node:http`, `node:crypto`, `node:sqlite`) → superfície de
supply-chain mínima. **50 testes de integração** (`npm test`) cobrem autenticação, dinheiro, concorrência, criptografia e LGPD.

## Início rápido (desenvolvimento)
```bash
npm test            # 50 testes
npm start           # sobe em 127.0.0.1:8080 com chaves de DEV (nunca expor)
```
## Produção
1. `npm run gen-keys` → coloque em cofre de segredos e preencha `.env` (veja `.env.example`).
2. `docker compose up -d` (Caddy faz TLS automático; edite o domínio no `Caddyfile`).
3. `docker compose exec api node --no-warnings scripts/create-admin.js ops@empresa.com.br superadmin` (anote senha e TOTP).
4. Crie os validadores: `scripts/create-validator.js "Ônibus 105 / 01"` (o segredo aparece uma única vez).
5. Agende `scripts/backup.sh` (hora em hora) e `scripts/verify-ledger.js` (diário; alerte se sair ≠ 0).
6. Troque os adaptadores `mock` pelos reais (PSP, bilhetagem, notificações) — `docs/INTEGRATIONS.md`.
   Em produção o servidor **recusa subir** com adaptadores mock (exceto piloto: `ALLOW_MOCK_ADAPTERS=1`).

## Estrutura
```
src/app.js            roteador HTTP, headers de segurança, CORS por allowlist, limites, tratamento de erro
src/config.js         configuração por ambiente; falha fechada em produção
src/db.js + migrations SQLite (WAL), transações síncronas BEGIN IMMEDIATE, seed de tarifas
src/core/ledger.js    razão imutável (triggers) e encadeado por hash; retenção (hold) de saldo
src/core/audit.js     auditoria imutável encadeada
src/lib/crypto.js     scrypt+pepper, AES-256-GCM com rotação de chave, índice cego, TOTP, ECDSA P-256
src/services/*        auth, stepup, cards, recharges(+webhook), boarding, refunds, profile(LGPD), admin, benefits
src/adapters/*        PSP (Pix), bilhetagem, notificações — pontos de integração
test/*                suíte de integração
```
## Limites conhecidos (leia `docs/SECURITY.md` §"O que este servidor NÃO resolve sozinho")
SQLite atende a um nó (piloto/milhares de usuários). Para alta disponibilidade, migrar para PostgreSQL gerenciado
(o SQL é padrão; as transações estão isoladas em `db.tx`). Rate limit é em memória (1 instância) — para N instâncias, Redis.
