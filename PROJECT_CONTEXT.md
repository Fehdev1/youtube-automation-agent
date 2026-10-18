# APP DO YOUTUBER – Contexto do Projeto

## Objetivo

Criação de vídeo para YouTube e TikTok, com automação do canal usando agentes de IA.
Uso **pessoal**: roda somente no meu computador (Windows), não é publicado nem usado por outras pessoas.

## Origem

- Base: github.com/darkzOGx/youtube-automation-agent
- Meu fork: github.com/Fehdev1/youtube-automation-agent (remote `origin`)
- Branch de trabalho: `meu-projeto`
- Pasta local: `C:\dev\youtube-automation-agent` (no Git Bash: `/c/dev/youtube-automation-agent`)

## Stack

- Node.js, npm, testes com `npm test`
- Editor: VS Code; terminal: Git Bash
- APIs usadas: YouTube Data API v3 (com OAuth) e um provedor de IA à escolha (o projeto original aceita Gemini, OpenAI, Claude, Ollama ou API compatível com OpenAI). Confirmar qual estou usando no `.env`.

## Arquitetura

Projeto em JavaScript (Node.js), organizado em agentes de IA que cuidam de cada etapa do canal: estratégia de conteúdo, roteiro, thumbnail, SEO, publicação e análise. Segundo o README do projeto original, `agents/` guarda os agentes e `schedules/` os agendadores da automação. As demais descrições abaixo são deduzidas pelo nome e devem ser confirmadas ao revisar o código.

Pastas:

- `agents/`: implementação dos agentes de IA (README original)
- `schedules/`: agendadores da automação (README original)
- `config/`: configurações (pelo nome)
- `dashboard/`: painel web (pelo nome; entra na etapa 2 de segurança)
- `database/` e `data/`: banco de dados e dados do projeto (pelo nome)
- `mcp/`: integração MCP (pelo nome)
- `utils/`: funções auxiliares (pelo nome)
- `scripts/`: scripts de apoio (pelo nome)
- `assets/`, `temp/`, `reports/`, `logs/`: arquivos de mídia, temporários, relatórios e registros (pelo nome)
- `docs/`, `examples/`, `.github/`: documentação, exemplos e configuração do GitHub (pelo nome)
- `node_modules/`: dependências instaladas pelo `npm install` (não vai para o GitHub)

Arquivos principais:

- `index.js`: ponto de entrada (`npm start`)
- `setup.js` e `walkthrough.js`: configuração guiada (`npm run setup`, `npm run walkthrough`)
- `oauth-server.js` e `modern-auth.js`: autenticação OAuth com o YouTube (área do patch de segurança da etapa 1)
- `test.js`: testes (`npm test`)
- `.env.example`: modelo das variáveis e chaves
- `package.json`: scripts e dependências
- `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`: documentação e licença
- `PROJECT_CONTEXT.md`: este documento

## Como rodar

1. `git clone https://github.com/Fehdev1/youtube-automation-agent.git`
2. `cd youtube-automation-agent && git checkout meu-projeto`
3. `npm install`
4. Copiar `.env.example` para `.env` e preencher as chaves (o `.env` nunca vai para o GitHub)
5. `npm test` / `npm start`

## Decisões e segurança já feitas

- Objetivo geral: testar e validar o repositório, achar falhas de segurança e código mal escrito, e adaptar para o meu projeto.
- Etapa 1 (feita): patch de segurança do OAuth, com commit e push na branch `meu-projeto`. Testes: 49 passando.
- Etapa 2 (pendente): dashboard, headers, dependências.

## Próximos passos

1. Etapa 2 de segurança: dashboard, headers e dependências.
2. Adaptação do projeto: modificações e criações novas.
3. Preencher a seção Arquitetura deste documento.

## Regras

- Nunca colocar chaves, tokens ou senhas neste documento nem no repositório.
- Chaves ficam só no `.env`, que deve estar no `.gitignore`.
