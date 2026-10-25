# To Bus — gerar APK pelo GitHub

1. Crie um repositório novo no GitHub (pode ser privado).
2. Envie **todo o conteúdo deste ZIP** para a raiz do repositório, incluindo a pasta `.github`.
3. Abra a aba **Actions**.
4. Entre em **Build To Bus APK** e toque em **Run workflow**.
5. Aguarde o job terminar com marca verde.
6. Abra a execução concluída e, em **Artifacts**, baixe **ToBus-Demo-APK**.
7. Extraia o ZIP baixado pelo GitHub e instale `app-debug.apk` no Android.

## Importante
Esta compilação é de demonstração. O `config.js` está com `MODO_DEMO: true`, portanto Pix e movimentações financeiras não têm valor real.

O APK debug é adequado para testes e apresentações internas. Antes de publicar em loja ou distribuir como produto final, será necessário configurar assinatura release, servidor de produção, política de privacidade e integrações reais aprovadas.
