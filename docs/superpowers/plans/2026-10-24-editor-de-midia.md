# Editor de mídia (fases 1 e 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aba "Editor de mídia" no painel: biblioteca por vídeo, linha do tempo com prévia ao vivo, MP4 pelo FFmpeg e exportação para o CapCut.

**Architecture:** Quatro módulos puros ou quase puros (`editor-project`, `editor-library`, `editor-renderer`, `editor-export`) orquestrados por `EditorService`, expostos por rotas `/api/editor/*` em `index.js` e consumidos por `dashboard/editor.js`. O projeto é um JSON por produção na tabela `editor_projects`, com controle de versão.

**Tech Stack:** Node 18+, Express, sqlite3, FFmpeg/ffprobe (`utils/ffmpeg.js`), sharp; HTML/CSS/JS puro no painel; testes no `test.js` (`SystemTest`).

**Spec:** `docs/superpowers/specs/2026-10-24-editor-de-midia-design.md`

## Global Constraints

- Saída 1920x1080, 30 fps, H.264 yuv420p CRF 20, AAC 192 kbps; loudnorm I=-14.
- Zoom linear 1,0→1,12 (in) ou 1,12→1,0 (out); fade 0,5 s; bloco ≥ 1 s; tolerância da soma 0,05 s.
- Envios: jpg, jpeg, png, webp, mp4, mp3, wav; ≤ 200 MB; gravados em `data/assets/<produção>/uploads/`.
- MP4 em `data/videos/<produção>_editor_<AAAAMMDD-HHMMSS>.mp4`; exportação em `data/export/<título-limpo>/`.
- Toda rota que altera dados usa `this.requireAPIKey()`; arquivos só por `assetId`, sempre dentro de `data/`.
- Todo texto visível em pt-BR; nenhuma rolagem lateral de 375 px a 1900 px.
- Argumentos do FFmpeg sempre por array (`execFile`), nunca por string de shell.

## Review Focus

1. Nomes de arquivo com acentos, espaços ou cirílico (há um no vídeo 1): render e exportação funcionam. Teste na Task 4 (render real com nome unicode) e na Task 5.
2. Mais imagens que segundos de narração: a montagem inicial nunca cria bloco < 1 s (usa no máximo `floor(duração)` imagens). Teste na Task 1.
3. Vídeo enviado mais curto que o bloco ou sem trilha de áudio: o segmento repete o vídeo e ignora o som. Teste na Task 4.
4. Projeto com 40 ou mais blocos: o filtro do FFmpeg vai para um arquivo (`-filter_complex_script`) e não estoura o limite de linha de comando do Windows. Teste na Task 4.
5. Música mais curta que a narração: termina em silêncio, sem quebrar a mixagem (`apad`). Teste na Task 4.

---

### Task 1: Modelo do projeto (`utils/editor-project.js`)

**Files:** Create `utils/editor-project.js`; Test: `test.js` (método `testEditorProject`, registrado como "Editor Project Model").

**Interfaces — Produces:**
- `class EditorError extends Error { constructor(message: string, status = 400) }`
- `FADE_SECONDS = 0.5`, `ZOOM_MAX = 1.12`, `ZOOMS = ['none','in','out']`, `TRANSITIONS = ['cut','fade']`
- `parseSRT(text: string) -> Array<{ start: number, end: number, text: string }>` (segundos)
- `buildInitialProject({ narrationDuration: number, captions: Caption[], imageAssetIds: string[] }) -> Project`
- `normalizeProject(project: Project, { narrationDuration: number, kinds: Map<assetId, 'image'|'video'|'audio'> }) -> Project` (lança `EditorError` 400 com mensagem em pt-BR)
- `blockTimes(project) -> Array<{ id: string, start: number, end: number }>`
- Project = `{ schema: 1, resolution: '1920x1080', fps: 30, narration: { assetId: 'narration', duration }, music: null | { assetId, start, end, volume, duck }, blocks: [{ id, assetId, duration, zoom, transition }] }`

- [ ] **Step 1: Write the failing tests**: (a) `parseSRT` lê `00:00:01,500 --> 00:00:03,000`; (b) 60 s de narração, 3 imagens e legendas terminando em frases aos 19,5 s e 41 s geram blocos com cortes em 19,5 e 41, soma 60, zoom alternado in/out/in e transição cut/fade/fade; (c) sem legendas, 3 imagens em 60 s viram 20/20/20; (d) 3 s de narração e 10 imagens geram no máximo 3 blocos, todos ≥ 1 s; (e) `normalizeProject` recusa bloco de 0,5 s, `assetId` desconhecido, áudio num bloco, zoom `'spin'`, música com volume 1,5 e `start >= end`; (f) força o primeiro bloco para `cut`; (g) com soma 58, estica o último bloco até 60.
- [ ] **Step 2: Run** `node -e "new (require('./test').SystemTest)().testEditorProject().then(()=>console.log('PASS'),e=>console.log('FAIL',e.message))"`. Expected: FAIL (módulo inexistente).
- [ ] **Step 3: Implement.** Cortes da montagem inicial: para cada alvo `k*D/N`, escolha o fim de legenda terminado em `[.!?…]` mais próximo que mantenha o bloco anterior e o restante ≥ 1 s; sem candidato, use o alvo. `N = min(imagens, floor(D))`.
- [ ] **Step 4: Run** de novo. Expected: PASS.
- [ ] **Step 5: Commit** `feat(editor): modelo do projeto e montagem inicial`

### Task 2: Persistência (`database/db.js`)

**Files:** Modify `database/db.js` (array `tables` em `createTables`, novos métodos perto de `listShortClips`); Test: `testEditorPersistence`.

**Interfaces — Produces:**
- Tabela `editor_projects(production_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, project TEXT NOT NULL, render_state TEXT, export_path TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`
- `getEditorProject(productionId) -> null | { productionId, version, project, renderState, exportPath, updatedAt }`
- `saveEditorProject(productionId, project, expectedVersion: number|null) -> { version }`. Com `null`, insere a versão 1. Qualquer divergência lança um erro com `status = 409`.
- `saveEditorRenderState(productionId, renderState: object)` e `saveEditorExportPath(productionId, path)`
- `listEditorRenderStates() -> Array<{ productionId, renderState }>`

- [ ] **Step 1: Failing test**: inserir (versão 1), salvar com 1 (passa a 2), salvar de novo com 1 (status 409), ler de volta o JSON igual, gravar o estado da montagem e listá-lo. Use o id `test_editor_<timestamp>` e apague a linha no `finally`.
- [ ] **Step 2: Run** e ver FAIL. **Step 3: Implement** com `UPDATE … WHERE production_id = ? AND version = ?` e checagem de `changes`. **Step 4: Run** e ver PASS. **Step 5: Commit** `feat(editor): tabela editor_projects com versão`.

### Task 3: Biblioteca (`utils/editor-library.js`)

**Files:** Create `utils/editor-library.js`; Test: `testEditorLibrary`.

**Interfaces — Consumes:** `EditorError`. **Produces:**
- `buildLibrary(bundle, { dataDir }) -> Promise<{ assets: Asset[], narration: Asset|null, texts: { script, captions, title, description, tags }, captionsPath: string|null }>`
- Asset = `{ id, kind: 'image'|'video'|'audio', origin: 'wikimedia'|'upload'|'generated'|'narration', name, path, credit: string|null }`
- ids: `'narration'`, `wm_<slug>_<hash8>`, `up_<…>`, `gen_<…>`, em que `hash8` são os 8 primeiros caracteres hexadecimais do sha1 do nome do arquivo e `slug` é o nome sem extensão, em minúsculas, limitado a `[a-z0-9-]` e 30 caracteres
- `saveUpload(productionId, fileName, buffer, { dataDir }) -> Promise<Asset>`
- `resolveAssetPath(library, assetId, dataDir) -> string` (404 se não existir; 403 se `path.relative(dataDir, p)` começar com `..`)
- Fontes: `data/assets/<id>/*` (sem `uploads/` nem `CREDITOS.txt`) como wikimedia; `uploads/*`; `bundle.assets.video.visualAssets` com extensão de imagem como generated; `bundle.assets.audio.path`, `captions.path` e `script.ttsPath`; o SEO em `bundle.seo` (pode vir em string JSON). O crédito vem do bloco do `CREDITOS.txt` cujo cabeçalho é o nome do arquivo.

- [ ] **Step 1: Failing tests** (pasta temporária como `dataDir`): o id é o mesmo em duas chamadas; o crédito é lido; `saveUpload` recusa `.exe` e 201 MB (400), limpa `"../a b.JPG"` para algo dentro de `uploads/` e devolve `kind: 'image'`; `resolveAssetPath` com um asset falso fora de `dataDir` dá 403.
- [ ] **Steps 2-5:** rodar e ver FAIL → implementar → rodar e ver PASS → commit `feat(editor): biblioteca de mídia por produção`.

### Task 4: Renderizador (`utils/editor-renderer.js`)

**Files:** Create `utils/editor-renderer.js`; Test: `testEditorRenderer` (argumentos) e `testEditorRenderReal` (FFmpeg real).

**Interfaces — Consumes:** `runFFmpeg`, `getMediaDuration` (`utils/ffmpeg.js`), `blockTimes`, `FADE_SECONDS`, `ZOOM_MAX`. **Produces:**
- `buildSegmentArgs({ block, asset, duration, isPortrait, outPath }) -> string[]`. A imagem usa `-loop 1 -t duration`, com cover em 1920x1080 e `zoompan` (`z` linear em `on/(frames)` entre 1 e 1,12; `d=1`; `s=1920x1080`; `fps=30`). Em retrato, o fundo é `split → scale cover + boxblur=20` e a imagem é sobreposta centralizada. O vídeo usa `-stream_loop -1 -t duration -an` com cover. Sempre `-r 30 -pix_fmt yuv420p -c:v libx264 -crf 20`.
- `buildJoinArgs({ segments: Array<{ path, duration, transition }>, scriptPath, outPath }) -> { args: string[], script: string }`. O filtro (cadeia de `xfade=transition=fade:duration=0.5:offset=…` ou `concat`) é escrito em `scriptPath` e referenciado por `-filter_complex_script`.
- `buildAudioArgs({ videoPath, narrationPath, music: null|{ path, start, end, volume, duck }, duration, outPath }) -> string[]`. A música passa por `atrim`, `volume`, `apad` e `atrim=0:duration`. Com `duck`, usa `sidechaincompress` com a narração como sidechain. Depois vem `amix`, e por último `loudnorm=I=-14:TP=-1.5:LRA=11`, com `-c:a aac -b:a 192k -shortest`.
- `renderProject({ project, library, outPath, tempDir, onProgress, run = runFFmpeg }) -> Promise<string>`. O segmento com o próximo bloco em `fade` ganha +0,5 s. A orientação vem de `sharp(path).metadata()` (altura > largura). O progresso é `{ stage: 'segments'|'finalizing', current, total, percent }` e os temporários são apagados num `finally`.

- [ ] **Step 1: Failing tests (argumentos):** zoom `in` contém `zoompan` e `1.12`; o retrato contém `boxblur`; o vídeo contém `-stream_loop` e `-an`; o join com [cut, fade, cut] gera exatamente 1 `xfade` no script; 60 segmentos ficam com `args.join(' ').length < 2000` e o filtro dentro do script; o áudio com `duck` contém `sidechaincompress`, sem `duck` não contém; contém `loudnorm=I=-14`; a música contém `apad`.
- [ ] **Step 2: Failing test (real):** gerar com FFmpeg, no `os.tmpdir()`, 3 PNGs (um em retrato, outro chamado `Катастрофа imagem.png`), um MP4 de 1 s sem áudio e 3 s de narração (`sine`). O projeto de 3 blocos (imagem, vídeo, imagem em retrato, fade no 2º) mais uma música de 1 s gera um MP4 com `getMediaDuration` de 3 ± 0,2 s, e o ffprobe mostra fluxos de áudio e de vídeo.
- [ ] **Steps 3-5:** implementar → rodar os dois testes e ver PASS → commit `feat(editor): renderização FFmpeg do projeto`.

### Task 5: Exportação para o CapCut (`utils/editor-export.js`)

**Files:** Create `utils/editor-export.js`; Test: `testEditorExport`.

**Interfaces — Produces:** `exportForCapCut({ project, library, texts, title, exportRoot }) -> Promise<string>` (caminho da pasta). Ela recria a pasta e grava `01_narracao.<ext>`, `02_legenda.srt` (se houver), `03_roteiro.txt`, `04_youtube.txt` (TÍTULO, DESCRIÇÃO, TAGS e CRÉDITOS DAS IMAGENS com os créditos dos assets usados), `05_ordem_e_tempos.txt` (linhas `001 · 00:00.0 → 00:18.4 · <nome> · zoom aproximar · corte`), `imagens/001_<nome>` (uma cópia por bloco) e `musica/<nome>`. O título limpo é `a-z0-9` mais hífens, com 60 caracteres.

- [ ] **Steps 1-5:** teste com 2 blocos e um nome unicode: a pasta tem os 5 arquivos, mais `imagens/001_*` e `002_*`, e o `05` tem 2 linhas com os tempos certos (00:00.0 → 00:02.0) → FAIL → implementar → PASS → commit `feat(editor): exportação para CapCut`.

### Task 6: Serviço (`utils/editor-service.js`)

**Files:** Create `utils/editor-service.js`; Test: `testEditorService` (com o banco e as funções `render` e `getDuration` falsos).

**Interfaces — Consumes:** Tasks 1-5. **Produces** `class EditorService { constructor(db, { dataDir, exportRoot, videosDir, tempRoot, logger, render = renderProject, getDuration = getMediaDuration }) }`:
- `listProductions() -> Array<{ id, title, createdAt, hasProject, hasNarration }>` (a partir de `db.getProductionPipeline()`)
- `getEditor(productionId) -> { version, project, library: Asset[], texts, render: RenderState, issues: Array<{ blockId, message }>, canRender: boolean, blockedReason: string|null }`. Cria e salva a montagem inicial quando não existe. Os `issues` apontam blocos com arquivo inexistente.
- `saveProject(productionId, { version, project }) -> { version, project }` (normaliza e repassa os 409)
- `addUpload(productionId, fileName, buffer) -> Asset`, `assetPath(productionId, assetId) -> string`
- `startRender(productionId) -> RenderState` (409 se qualquer montagem estiver `running`; 400 com `blockedReason`), `getRenderState(productionId)`, `markInterruptedRenders()`
- RenderState = `{ status: 'idle'|'running'|'completed'|'failed'|'interrupted', percent, message, outputPath, error, startedAt, finishedAt }`. As mensagens são "Montando bloco X de N" e "Finalizando áudio e vídeo".
- `exportProject(productionId) -> { path }`, `outputFolder(productionId) -> string|null`

- [ ] **Steps 1-5:** testes: o primeiro `getEditor` cria a versão 1 com N blocos; um bloco com arquivo apagado gera um `issue` e `canRender=false`; sem narração, `blockedReason` contém "narração"; um segundo `startRender` enquanto o render falso está pendente dá 409; o render falso que rejeita termina em `failed` com a mensagem; `markInterruptedRenders` troca `running` por `interrupted` → FAIL → implementar → PASS → commit `feat(editor): serviço do editor`.

### Task 7: Rotas (`index.js`)

**Files:** Modify `index.js` (instanciar `this.editor` junto de `this.scenes`, chamar `markInterruptedRenders()`; rotas em `setupAPI` perto de `/api/content/:productionId`); Test: `testEditorRoutes` (servidor em porta livre, como o teste em `test.js:326`).

Rotas conforme a tabela da spec. `GET /assets/:assetId` usa `res.sendFile` (dá suporte a Range). `uploads` usa `express.raw({ type: '*/*', limit: '200mb' })` com o cabeçalho `x-file-name`. `open-folder` usa `execFile('explorer.exe', [folder])` apenas em `win32` (senão 501). Erros com `status` viram `{ error }` naquele status.

- [ ] **Steps 1-5:** o teste HTTP sobe o `MainAgent` falso, ou só `setupAPI` com o `editor` falso: GET da lista dá 200; PUT com versão velha dá 409; o asset com id desconhecido dá 404; o upload `.exe` dá 400 → FAIL → implementar → PASS → commit `feat(editor): rotas /api/editor`.

### Task 8: Painel (`dashboard/editor.js`, `dashboard/editor.css`)

**Files:** Create `dashboard/editor.js`, `dashboard/editor.css`; Modify `dashboard/index.html` (botão de navegação `data-view="editor"` depois do operador; `<section id="editor-view">`; o `<link>` e o `<script defer>`), `dashboard/app.js` (`titles.editor = ['EDITOR DE MÍDIA', 'Monte o vídeo sem sair do app.']`, lista de views válidas, botão "Abrir no editor" na revisão, que chama `window.openEditor(id)`), `dashboard/enhance.js` (`MINI_LABELS.editor = 'Editor'`, `VIEW_META.editor`).

`editor.js` expõe `window.openEditor(productionId)` e tem estas responsabilidades:
- Lista de vídeos
- Biblioteca com abas e arrastar e soltar (POST de upload)
- Prévia: o `<audio>` da narração é o relógio. Um `requestAnimationFrame` escolhe o bloco ativo pelo `blockTimes` e aplica `transform: scale(1→1.12)` e `opacity` no fade de 0,5 s. Uma segunda `<audio>` toca a música, com volume reduzido para `volume*0.35` enquanto a narração toca, se `duck`. A legenda vem da `parseSRT` portada.
- Linha do tempo: largura proporcional; HTML5 DnD para reordenar e trocar a imagem; arrastar a borda direita ajusta a duração com o restante aplicado ao último bloco; waveform num `<canvas>` via `AudioContext.decodeAudioData`
- Propriedades
- Desfazer e refazer (pilha de 50 cópias do projeto)
- Salvamento automático (debounce de 1000 ms; em 409, mostra o aviso "este projeto foi alterado em outra aba; recarregue")
- Gerar MP4 (POST e polling de 1 s; "Assistir" usa `/api/editor/:id/assets/output` ou um link direto, conforme o `outputPath` exposto pela rota de estado)
- Exportar e "Abrir pasta"
- Blocos com `issue` em vermelho

Todos os textos em pt-BR.

- [ ] **Step 1:** implementar. **Step 2:** `node --check` nos JS do painel. **Step 3:** conferir no navegador (painel interno) a 375 px e 1900 px: zero elementos fora dos painéis (o script de verificação usado na correção do card) e a prévia tocando. **Step 4:** commit `feat(editor): aba Editor de mídia no painel`.

### Task 9: Verificação de ponta a ponta

- [ ] Abrir o vídeo 1 (`prod_1792845728451_voa82stgcq_8odui595lik`) no painel, trocar uma imagem, ajustar uma duração e acrescentar um zoom, gerar o MP4, conferir a duração (≈ narração) e assistir um trecho.
- [ ] Exportar para o CapCut e conferir a pasta.
- [ ] `npm test`: só a falha antiga ("Engagement AI Provider Wiring").
- [ ] Revisão independente do branch inteiro.
