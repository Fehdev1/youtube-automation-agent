# Editor de mídia (fases 1 e 2): design

Data: 2026-10-24 · Status: aguardando revisão

## Objetivo

Dar ao app uma aba **"Editor de mídia"** onde todos os arquivos de cada vídeo ficam num só lugar e onde o vídeo longo pode ser montado e exportado em MP4 sem outro programa, mantendo a opção de exportar uma pasta pronta para o CapCut.

Contexto: o usuário gera roteiro, narração (Azure), legenda e imagens (Wikimedia) no app e hoje monta tudo à mão no CapCut, gastando 2 a 3 horas por vídeo. A meta é reduzir esse tempo dentro da rotina de 4 a 8 horas por semana do teste de 60 dias do canal Famous Mistérios.

## Escopo

**Nesta entrega (fases 1 e 2):**
- Biblioteca de mídia por vídeo: imagens, narração, músicas, roteiro, legenda e textos do YouTube
- Envio de imagens, vídeos e músicas do computador
- Linha do tempo com 3 trilhas (imagens, narração fixa, música) e montagem inicial automática
- Prévia ao vivo no navegador (zoom, transição, narração e música)
- Gerar MP4 1080p pelo FFmpeg
- Exportar pasta numerada para o CapCut

**Fora desta entrega (fases 3 e 4, cada uma com spec própria):** legenda gravada no vídeo, cortes 9:16 para Shorts, thumbnail, várias trilhas de imagem, textos na tela, efeitos, download em ZIP.

## Abordagem escolhida

Prévia no navegador + montagem final pelo FFmpeg (abordagem 1). Não depende do Playwright. É independente do Editor de cenas existente (`production_scenes` / `scene-repair-service.js`), que modela uma narração por cena. O editor usa uma narração única com imagens por cima.

## Tela (layout A, estilo CapCut)

- **Menu:** a aba "Editor de mídia" (rótulo curto "Editor") fica logo depois de "Operador autônomo". A revisão de conteúdo ganha o botão "Abrir no editor".
- **Lista de vídeos:** ao abrir a aba sem um vídeo escolhido, aparece a lista das produções (título, data, se já tem projeto). Clicar abre o editor daquele vídeo.
- **Biblioteca (esquerda):** abas Imagens | Áudio | Textos.
  - Imagens: as da pasta do vídeo, os visuais gerados e os enviados. Cada uma com miniatura e crédito no hover. Arrastar e soltar envia arquivos.
  - Áudio: a narração (só leitura) e as músicas enviadas.
  - Textos: roteiro, legenda, título, descrição e tags, cada um com botão "copiar".
- **Prévia (centro):** play/pausa, tempo atual, barra de avanço e legenda sobreposta como guia.
- **Propriedades (direita):** para o bloco selecionado, duração, zoom (nenhum / aproximar lento / afastar lento) e transição de entrada (corte / esmaecer 0,5 s). Sem seleção, mostra volume da música, "abaixar música durante a narração" e resolução (fixa em 1080p nesta entrega).
- **Linha do tempo (embaixo):** trilha de imagens (arrastar para reordenar, soltar imagem da biblioteca sobre um bloco para trocar, puxar a borda para mudar a duração), forma de onda da narração e trilha de música (início e fim ajustáveis). Tem zoom da linha do tempo, desfazer e refazer (Ctrl+Z / Ctrl+Shift+Z, até 50 passos, no navegador) e salvamento automático.
- **Botões:** "Gerar MP4" (com barra de progresso; ao final, "Assistir" e "Abrir pasta") e "Exportar para o CapCut" (ao final, "Abrir pasta").
- Todos os textos em pt-BR e sem rolagem lateral de 375 px a 1900 px.

## Modelo de dados

Tabela nova em `database/db.js`:

```sql
CREATE TABLE IF NOT EXISTS editor_projects (
  production_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  project TEXT NOT NULL,          -- JSON abaixo
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

JSON do projeto:

```json
{
  "schema": 1,
  "resolution": "1920x1080",
  "fps": 30,
  "narration": { "assetId": "narration", "duration": 238.06 },
  "music": { "assetId": "up_ab12", "start": 0, "end": 238.06, "volume": 0.25, "duck": true },
  "blocks": [
    { "id": "b1", "assetId": "img_01", "duration": 18.4, "zoom": "in", "transition": "cut" }
  ]
}
```

A biblioteca **não** é gravada no projeto. Ela é montada na hora a partir das pastas, e cada arquivo recebe um `assetId` estável, derivado da origem e do nome do arquivo. `music` pode ser `null`.

Regras de validação (no servidor, a cada gravação):
- Cada bloco tem duração ≥ 1 s, e a soma das durações é igual à da narração (tolerância de 0,05 s). O servidor ajusta o último bloco para fechar a soma.
- `zoom` ∈ {none, in, out}. `transition` ∈ {cut, fade}. O primeiro bloco é sempre "cut".
- Todo `assetId` precisa existir na biblioteca do vídeo e ser de tipo compatível (imagem ou vídeo nos blocos, áudio na música).
- `music.volume` fica entre 0 e 1, e `0 ≤ start < end`.
- Gravar com `version` diferente da atual retorna 409 (conflito).

## Montagem inicial automática

Na primeira vez que um vídeo é aberto no editor (sem projeto salvo):
1. Lê a duração real da narração (`getMediaDuration`) e a legenda `.srt` do vídeo.
2. Pega as imagens da pasta do vídeo em ordem de nome (as do Wikimedia já vêm numeradas). Se não houver nenhuma, usa os visuais gerados.
3. Divide a narração em N trechos de tamanho parecido (N = número de imagens), movendo cada corte para o fim de frase da legenda mais próximo. Se não houver legenda, corta em tempos iguais.
4. Alterna o zoom entre "aproximar" e "afastar" e usa "esmaecer" a partir do segundo bloco.

## Biblioteca e arquivos

- **Pastas lidas:** `data/assets/<produção>/` (Wikimedia), `data/assets/<produção>/uploads/` (envios), os visuais gerados listados em `assets.video.visualAssets`, a narração em `assets.audio.path`, a legenda em `assets.captions.path`, o roteiro em `assets.script.ttsPath`, e o SEO da produção.
- **Créditos:** lidos do `CREDITOS.txt` da pasta do vídeo, quando existir.
- **Envios:** aceitos JPG, PNG, WEBP, MP4, MP3 e WAV, até 200 MB, gravados em `data/assets/<produção>/uploads/` com nome limpo e sufixo único. Corpo bruto com cabeçalho `x-file-name`, no mesmo padrão da troca de visual do Editor de cenas.
- **Servir arquivos:** apenas por `assetId`, nunca por caminho vindo do navegador. Áudio e vídeo aceitam requisições `Range` para a prévia funcionar.
- Os originais nunca são alterados.

## API (todas as rotas que alteram dados usam `requireAPIKey`)

| Método e rota | Função |
|---|---|
| `GET /api/editor/productions` | Lista as produções: id, título, data, se tem projeto, se tem narração |
| `GET /api/editor/:productionId` | Projeto (cria a montagem inicial se não houver), biblioteca, textos e o estado da última montagem |
| `PUT /api/editor/:productionId` | Grava o projeto `{ version, project }` e devolve o projeto normalizado e a nova versão. 409 em conflito, 400 em validação. |
| `POST /api/editor/:productionId/uploads` | Envia um arquivo e devolve o novo item da biblioteca |
| `GET /api/editor/:productionId/assets/:assetId` | Entrega o arquivo (com suporte a `Range`) |
| `POST /api/editor/:productionId/render` | Inicia a montagem do MP4 (409 se já houver uma rodando) |
| `GET /api/editor/:productionId/render` | Estado da montagem: `idle | running | completed | failed | interrupted`, progresso, etapa, arquivo de saída e erro |
| `POST /api/editor/:productionId/export` | Cria a pasta para o CapCut e devolve o caminho |
| `POST /api/editor/:productionId/open-folder` | Abre no Explorer a pasta da última saída (`render` ou `export`). Só funciona com o app rodando no próprio computador. |

## Montagem do MP4 (FFmpeg)

- **Saída:** `data/videos/<produção>_editor_<AAAAMMDD-HHMMSS>.mp4`, com H.264 (yuv420p, CRF 20), AAC 192 kbps, 1920x1080, 30 fps. As versões anteriores são mantidas.
- **Etapa 1, um segmento por bloco** (arquivos temporários em `temp/editor/<produção>/`):
  - Imagem: escala para cobrir 1920x1080 e aplica `zoompan` de 1,0 a 1,12 (aproximar) ou de 1,12 a 1,0 (afastar) ao longo do bloco. Imagens em retrato: fundo da própria imagem escalado e desfocado, com a imagem centralizada por cima.
  - Vídeo enviado: escala para cobrir a tela, sem som, cortado na duração do bloco ou repetido se for mais curto.
- **Etapa 2, juntar:** `xfade=fade:duration=0.5` entre blocos com transição "fade" e concatenação simples nos "cut". Cada bloco com fade é estendido em 0,5 s, para a duração total continuar igual à da narração.
- **Etapa 3, áudio:** narração + música (cortada em `start`–`end`, com `volume`). Com `duck`, usa `sidechaincompress` disparado pela narração. Depois, `loudnorm` em -14 LUFS.
- **Progresso:** lido do `-progress` do FFmpeg e mostrado como "Montando bloco X de N" (etapa 1) e "Finalizando áudio e vídeo" (etapas 2 e 3), com uma porcentagem total.
- **Fila:** uma montagem por vez no app inteiro. O estado fica em memória e é gravado em `editor_projects` (última saída). Ao iniciar, o app marca como `interrupted` uma montagem que estava `running`.
- **A prévia usa as mesmas curvas:** zoom linear de 1,0 a 1,12 e fade de 0,5 s, com CSS `transform` e `opacity` sincronizados ao tempo do áudio.
- Os temporários são apagados ao terminar, com sucesso ou não.

## Exportação para o CapCut

Pasta `data/export/<título-limpo>/` (já ignorada pelo git):

```
01_narracao.mp3
02_legenda.srt
03_roteiro.txt
04_youtube.txt          título, descrição, tags e créditos das imagens
05_ordem_e_tempos.txt   uma linha por bloco: "001 · 00:00.0 → 00:18.4 · arquivo · zoom aproximar · corte"
imagens/001_<nome>.jpg  uma cópia por bloco, na ordem da linha do tempo
musica/<nome>.mp3       se houver música
```

Exportar de novo substitui a pasta daquele vídeo.

## Erros

| Situação | Comportamento |
|---|---|
| Arquivo do bloco sumiu ou está corrompido | O bloco fica marcado em vermelho ("arquivo não encontrado") e o MP4 fica bloqueado até a troca |
| Produção sem narração utilizável | O editor abre só com a biblioteca, avisa "gere a narração primeiro" e bloqueia o MP4 |
| Envio com tipo ou tamanho inválido | 400 com o motivo, exibido como aviso |
| Conflito de versão | 409; o editor mostra "este projeto foi alterado em outra aba; recarregue" |
| FFmpeg falhou | Estado `failed` com as últimas linhas relevantes do erro resumidas e botão "Tentar de novo" |
| App reiniciado durante a montagem | Estado `interrupted` e botão "Gerar de novo" |
| Caminho fora de `data/` | Recusado. Os arquivos são resolvidos só pelo `assetId`. |

## Organização do código

Unidades pequenas, cada uma testável sozinha:

- `utils/editor-project.js`: funções puras. Monta o projeto inicial a partir da duração, da legenda e das imagens; valida e normaliza; calcula início e fim de cada bloco.
- `utils/editor-library.js`: monta a biblioteca de uma produção (pastas, `assetId`, créditos e textos) e grava os envios.
- `utils/editor-renderer.js`: `buildSegmentArgs`, `buildJoinArgs` e `buildAudioArgs`, funções puras que geram os argumentos do FFmpeg, mais `render()`, que roda as etapas e reporta o progresso.
- `utils/editor-export.js`: cria a pasta para o CapCut.
- `utils/editor-service.js`: junta tudo (banco, versões, fila de montagem e estado).
- `index.js`: as rotas da tabela de API.
- `database/db.js`: a tabela `editor_projects` e os métodos `getEditorProject` e `saveEditorProject`.
- Painel: a nova seção em `dashboard/index.html`, com a lógica em `dashboard/editor.js` e o visual em `dashboard/editor.css`. Arquivos novos, para não inchar o `app.js` (que já tem 1.800 linhas).

## Testes (TDD, no `test.js`)

1. Montagem inicial: soma dos blocos = narração; cortes no fim de frase; sem legenda, cortes iguais; sem imagens, usa os visuais gerados.
2. Validação: recusa bloco < 1 s, `assetId` inexistente, tipo errado e zoom ou transição inválidos; ajusta o último bloco para fechar a soma.
3. Versão: gravar com versão antiga retorna conflito.
4. Biblioteca: `assetId` estável; envio recusa tipo e tamanho inválidos; nome limpo; arquivo fora de `data/` nunca é servido.
5. Argumentos do FFmpeg: zoom de aproximar e afastar, fundo desfocado para retrato, `xfade` só nos blocos com fade, `sidechaincompress` só com `duck`, `loudnorm`.
6. Montagem real pequena: projeto de 3 blocos e 3 segundos com imagens geradas no teste vira um MP4 que decodifica, com áudio e vídeo e duração de 3 s ±0,2.
7. Exportação: a pasta tem todos os arquivos, e o `05_ordem_e_tempos.txt` bate com a linha do tempo.
8. Tela: conferência no navegador em 375 px e 1900 px, sem elementos fora dos painéis, com prévia tocando e MP4 gerado de ponta a ponta com um vídeo real.

## Critérios de pronto

- Abrir um vídeo já gerado (por exemplo, o vídeo 1 do Colapso da Idade do Bronze), ajustar a linha do tempo, gerar o MP4 e assistir, tudo pelo painel
- Exportar a pasta e montar o mesmo vídeo no CapCut seguindo o `05_ordem_e_tempos.txt`
- `npm test` sem falhas novas
