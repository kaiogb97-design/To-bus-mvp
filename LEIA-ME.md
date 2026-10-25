# To Bus — MVP Completo para Demonstração

Versão local/offline voltada a testes e apresentações para investidores. **Não movimenta dinheiro real e não depende de servidor online.**

## Incluído no MVP
- Login e cadastro local demonstrativo
- Cartões Urbana, Estudantil e Rural
- Saldo, passagens estimadas e extrato
- Recarga e Pix simulados
- Transferência To Bus simulada entre contatos demonstrativos
- Validador/NFC virtual com desconto de tarifa fictícia
- Bloqueio/desbloqueio, PIN e biometria demonstrativa
- Segunda via e reembolso demonstrativos
- Linhas, tarifas, favoritos, notificações, suporte e assistente MAKEM
- Modo apresentação: carrega um cenário fictício pronto para investidores
- Projeto Android + GitHub Actions para gerar APK

## Importante
Pix, transferências, NFC/validador e saldos são apenas simulações do MVP. Não há integração bancária, bilhetagem oficial ou crédito financeiro real.

## Gerar APK
1. Extraia este ZIP.
2. Envie **o conteúdo da pasta extraída** para a raiz de um repositório GitHub (incluindo `.github`).
3. Abra Actions > Build To Bus APK > Run workflow.
4. Ao finalizar, baixe o artifact `ToBus-Demo-APK`.
5. Extraia e instale `app-debug.apk` em um Android de teste.

O workflow também roda automaticamente em pushes para `main`.
