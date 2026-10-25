# To Bus — MVP para demonstração a investidores

## Estado deste pacote
Este pacote está configurado em **MODO DEMO**. Nenhuma operação movimenta dinheiro real.

### O que já pode ser demonstrado
- Cadastro e login do protótipo.
- Tipos de cartão e perfil do usuário.
- Saldo, estimativa de passagens e extrato/histórico.
- Recarga com fluxo completo e **Pix visual simulado** (QR ilustrativo + botão “Simular pagamento”).
- Outras formas de pagamento apenas como experiência de interface; sem cobrança real.
- Bloqueio/desbloqueio do cartão, PIN e biometria simulada no modo demo.
- Solicitação de segunda via e fluxo de reembolso demonstrativo.
- Linhas/tarifas, notificações e suporte do protótipo.
- Backend de referência com autenticação, razão financeiro, recargas, validadores, backoffice e LGPD, para evolução futura.

### O que NÃO deve ser apresentado como real
- Pix, cartão, débito, carteira digital ou qualquer cobrança real.
- Transferência de dinheiro/saldo entre usuários: **não está implementada neste pacote**.
- NFC/validador físico real.
- Integração com bilhetagem real do transporte de Uberaba.
- SMS/e-mail reais.
- Biometria Android real no APK atual: existe material de hardening, mas precisa ser integrado a um projeto Android/Gradle e compilado.

## Como rodar a demonstração no computador
Requer Node.js 22 ou superior.

1. Abra um terminal nesta pasta.
2. Execute:
   - Windows: `iniciar-demo.bat`
   - Linux/macOS: `./iniciar-demo.sh`
3. Abra `http://localhost:8080` no navegador.

## Como testar a base do servidor
Dentro de `server/`, execute `npm test`. Este pacote foi validado com 51 testes do servidor.

Para testar a integração app-servidor, entre em `tests-app/` e execute:
`node --test --test-force-exit *.test.mjs`

## Próximo passo para um APK demonstrável
O pacote contém o `app/www` pronto para ser usado como conteúdo WebView. Para gerar APK é necessário um projeto Android/Gradle que incorpore essa pasta em `app/src/main/assets/www`. O diretório `android-hardening/` contém as peças de segurança que devem ser aplicadas ao wrapper Android.

Enquanto o projeto estiver em fase de captação, mantenha `window.TOBUS_CONFIG.MODO_DEMO = true` e não configure PSP/pagamentos reais.

## Próximas fases sugeridas
1. MVP demonstrável: manter pagamentos simulados e fechar a experiência visual.
2. Piloto técnico: hospedar API e banco apenas para dados de teste, mantendo adaptadores mock e sem dinheiro real.
3. Parcerias/investimento: negociar acesso à bilhetagem/validadores e definir requisitos jurídicos e operacionais.
4. Piloto controlado: integrar serviços reais somente após segurança, contratos e testes.
5. Produção: pagamentos/bilhetagem reais, monitoramento, backups, auditoria/pentest e publicação oficial.
