# Portfólio editorial com CMS

Portfólio em HTML/CSS/JavaScript com painel de administração, editor de artigos em Markdown, capas, temas e playlist Spotify. O mesmo frontend roda localmente e na Vercel.

## Rodar localmente

Requer Node.js 20+; não precisa configurar serviços externos para desenvolvimento local.

```bash
./start.sh
```

- Site: http://127.0.0.1:4173/
- Painel: http://127.0.0.1:4173/admin

Na primeira abertura do painel local, crie uma senha com pelo menos 12 caracteres.

Para parar e reiniciar: `./stop.sh` e depois `./start.sh`.

## Publicar na Vercel

A hospedagem usa uma função Node.js (`api/[...path].js`) e **Vercel Blob privado** para guardar o conteúdo editável, os backups e as capas que você envia. Assim, publicar outro deploy não apaga as alterações do CMS. O segredo de login fica nas variáveis de ambiente do projeto e a senha nunca vai para o código. O Blob precisa estar em modo privado porque contém o documento de conteúdo e versões de backup. Consulte o guia oficial de [armazenamento privado do Vercel Blob](https://vercel.com/docs/vercel-blob/private-storage).

### 1. Enviar este projeto para a Vercel

Use a Vercel CLI no terminal ou conecte um repositório Git ao projeto. Se usar a CLI, execute `npm install -g vercel`, depois `vercel login` e, dentro desta pasta, `vercel`. Isso cria primeiro um deploy de preview; confirme a aparência e as funções antes de promover para produção. O guia oficial explica [deploy por CLI ou Git](https://vercel.com/docs/deployments).

### 2. Conectar armazenamento persistente

No painel do projeto Vercel, abra **Storage → Create Storage → Blob** e escolha **Private** como acesso. Conecte o store a este projeto e aos ambientes que usará (Preview e Production; Development apenas se quiser testar funções hospedadas localmente). A Vercel adiciona as credenciais do store conectado, incluindo `BLOB_STORE_ID` e autenticação OIDC, quando a conexão está configurada corretamente.

### 3. Definir as variáveis de ambiente

Em **Project → Settings → Environment Variables**, crie estas variáveis para Production e Preview:

- `PORTFOLIO_ADMIN_PASSWORD` — sua senha administrativa única, com pelo menos 12 caracteres.
- `PORTFOLIO_SESSION_SECRET` — segredo de assinatura de cookies, com pelo menos 32 caracteres. Gere um valor aleatório no terminal, por exemplo `openssl rand -base64 48`; não use o exemplo literalmente nem o coloque no Git.

Além disso, a função espera que o Blob privado esteja conectado e disponibilize `BLOB_STORE_ID` e `VERCEL_OIDC_TOKEN` (ou, quando estiver fora da Vercel, `BLOB_READ_WRITE_TOKEN`). Não digite nem compartilhe esses tokens no código-fonte. O arquivo `.env.example` só lista os nomes das configurações e não contém credenciais reais.

Depois de salvar as variáveis, crie um novo deployment. Na primeira requisição pública, o CMS inicializa o conteúdo persistente usando `data/content.json` como base. As alterações posteriores ficam no Blob privado.

### 4. Usar o CMS online

- Acesse `https://seu-dominio/admin`.
- Entre usando `PORTFOLIO_ADMIN_PASSWORD`.
- Edite o que precisar e clique em **Salvar alterações**.
- Itens em estado **Rascunho** ou **Oculto** ficam fora da página pública.
- Imagens enviadas vão para o Blob privado e são servidas por `/api/file`; para cumprir o limite de corpo de requisição da Vercel, este painel hospedado aceita capas de até 2,8 MB.
- Use **Exportar conteúdo** antes de grandes alterações; o servidor também grava cópias anteriores no Blob privado.

### Como saber se falta configuração

Se `/admin` mostrar “Finalize a configuração do site”, consulte `Project → Settings → Environment Variables`, confirme a conexão do Blob privado e faça outro deploy. Não remova o armazenamento nem troque seu prefixo sem fazer um backup exportado.

## Segurança e persistência

- `data/content.json` é a base inicial de conteúdo público.
- No modo local, o conteúdo editável fica em `data/content.json`; a senha local é guardada como hash em `data/auth.json` e backups em `data/backups/`.
- Na Vercel, conteúdo atual e backups ficam em Blob privado; nunca são entregues diretamente pelo endpoint público de conteúdo.
- `PORTFOLIO_ADMIN_PASSWORD`, `PORTFOLIO_SESSION_SECRET` e os tokens Blob não devem entrar no Git.
- O login usa cookie HttpOnly, SameSite=Strict, Secure na hospedagem, expiração e limitação de tentativas por instância.

## Arquivos principais

- `app.js` / `styles.css`: frontend do portfólio e leitor de artigos.
- `admin.html` / `admin.js` / `admin.css`: painel editorial.
- `server.cjs`: servidor local e persistência para desenvolvimento.
- `api/[...path].js`: API da Vercel, login, conteúdo persistente, backups e imagens.
- `vercel.json`: reescrita de `/admin` e configurações de funções e cabeçalhos.
- `data/content.json`: dados iniciais do site.
- `start.sh` / `stop.sh`: iniciar/parar a versão local.
