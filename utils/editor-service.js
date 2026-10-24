// Media editor orchestration: loads a production's library and project,
// saves versioned edits, runs one MP4 render at a time and exports for CapCut.
const path = require('path');
const fs = require('fs').promises;
const { getMediaDuration } = require('./ffmpeg');
const { EditorError, parseSRT, buildInitialProject, normalizeProject } = require('./editor-project');
const { buildLibrary, saveUpload, resolveAssetPath } = require('./editor-library');
const { renderProject } = require('./editor-renderer');
const { exportForCapCut } = require('./editor-export');

const IDLE = { status: 'idle', percent: 0, message: '', outputPath: null, error: null, startedAt: null, finishedAt: null };

const parseJson = value => (typeof value === 'string' ? JSON.parse(value || '{}') : (value || {}));

function stamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// FFmpeg errors are long; keep the lines that name the problem.
function summarizeError(error) {
  const lines = String(error.stderr || '').split('\n').map(line => line.trim())
    .filter(line => /error|invalid|no such file|could not|failed/i.test(line) && !/^Conversion failed/i.test(line));
  return (lines.slice(-2).join(' · ') || error.message || 'Erro desconhecido').slice(0, 400);
}

class EditorService {
  constructor(db, options = {}) {
    const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
    this.db = db;
    this.dataDir = dataDir;
    this.exportRoot = options.exportRoot || path.join(dataDir, 'export');
    this.videosDir = options.videosDir || path.join(dataDir, 'videos');
    this.tempRoot = options.tempRoot || path.join(__dirname, '..', 'temp', 'editor');
    this.logger = options.logger;
    this.render = options.render || renderProject;
    this.getDuration = options.getDuration || getMediaDuration;
    this.renders = new Map();
    this.activeId = null;
    this.running = Promise.resolve();
  }

  async listProductions() {
    const rows = await this.db.listEditorProductions();
    return rows.map(row => {
      const assets = parseJson(row.assets);
      return {
        id: row.id,
        title: parseJson(row.seo).title || parseJson(row.script).title || row.id,
        createdAt: row.created_at,
        hasProject: Boolean(row.has_project),
        hasNarration: Boolean(assets.audio?.path) && assets.audio?.simulated !== true
      };
    });
  }

  async load(productionId) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) throw new EditorError('Vídeo não encontrado.', 404);
    const library = await buildLibrary(bundle, { dataDir: this.dataDir });
    const narrationDuration = library.narration ? await this.getDuration(library.narration.path) : 0;
    const title = library.texts.title || parseJson(bundle.script).title || productionId;
    return { bundle, library, narrationDuration, title };
  }

  async getEditor(productionId) {
    const { library, narrationDuration, title } = await this.load(productionId);
    let stored = await this.db.getEditorProject(productionId);
    if (!stored?.project) {
      const imageAssetIds = library.assets.filter(asset => asset.kind === 'image' && asset.origin !== 'upload').map(asset => asset.id);
      const project = buildInitialProject({ narrationDuration, captions: parseSRT(library.texts.captions), imageAssetIds });
      const { version } = await this.db.saveEditorProject(productionId, project, null);
      stored = { version, project, renderState: null };
    }

    const known = new Set(library.assets.map(asset => asset.id));
    const issues = stored.project.blocks
      .filter(block => !known.has(block.assetId))
      .map(block => ({ blockId: block.id, message: 'Arquivo não encontrado' }));
    const blockedReason = !library.narration ? 'Gere a narração primeiro: este vídeo ainda não tem narração.'
      : !stored.project.blocks.length ? 'Adicione pelo menos uma imagem à linha do tempo.'
        : issues.length ? 'Troque os arquivos que estão faltando (blocos em vermelho).' : null;

    return {
      title,
      version: stored.version,
      project: stored.project,
      library: [library.narration, ...library.assets].filter(Boolean),
      texts: library.texts,
      render: await this.getRenderState(productionId),
      issues,
      canRender: blockedReason === null,
      blockedReason
    };
  }

  async saveProject(productionId, { version, project }) {
    const { library, narrationDuration } = await this.load(productionId);
    const kinds = new Map(library.assets.map(asset => [asset.id, asset.kind]));
    const normalized = normalizeProject(project, { narrationDuration, kinds });
    const saved = await this.db.saveEditorProject(productionId, normalized, version);
    return { version: saved.version, project: normalized };
  }

  async addUpload(productionId, fileName, buffer) {
    await this.load(productionId);
    return saveUpload(productionId, fileName, buffer, { dataDir: this.dataDir });
  }

  async assetPath(productionId, assetId) {
    if (assetId === 'output') {
      const output = (await this.getRenderState(productionId)).outputPath;
      if (!output) throw new EditorError('Nenhum MP4 gerado ainda.', 404);
      return output;
    }
    const { library } = await this.load(productionId);
    return resolveAssetPath(library, assetId, this.dataDir);
  }

  async getRenderState(productionId) {
    if (this.renders.has(productionId)) return this.renders.get(productionId);
    const stored = await this.db.getEditorProject(productionId);
    return stored?.renderState || { ...IDLE };
  }

  async setRenderState(productionId, changes) {
    const state = { ...(await this.getRenderState(productionId)), ...changes };
    this.renders.set(productionId, state);
    await this.db.saveEditorRenderState(productionId, state).catch(error => this.logger?.warn(`Editor render state not saved: ${error.message}`));
    return state;
  }

  async startRender(productionId) {
    if (this.activeId) throw new EditorError('Já existe um vídeo sendo montado; espere terminar.', 409);
    const editor = await this.getEditor(productionId);
    if (!editor.canRender) throw new EditorError(editor.blockedReason);
    const { library } = await this.load(productionId);

    this.activeId = productionId;
    const outPath = path.join(this.videosDir, `${productionId}_editor_${stamp()}.mp4`);
    const state = await this.setRenderState(productionId, {
      ...IDLE, status: 'running', message: 'Preparando…', startedAt: new Date().toISOString()
    });

    this.running = this.render({
      project: editor.project,
      library: { assets: library.assets, narration: library.narration },
      outPath,
      tempDir: path.join(this.tempRoot, productionId),
      onProgress: progress => {
        const message = progress.stage === 'segments'
          ? `Montando bloco ${progress.current} de ${progress.total}` : 'Finalizando áudio e vídeo';
        this.setRenderState(productionId, { percent: progress.percent, message });
      }
    }).then(
      output => this.setRenderState(productionId, {
        status: 'completed', percent: 100, message: 'Vídeo pronto', outputPath: output, finishedAt: new Date().toISOString()
      }),
      error => {
        this.logger?.error(`Editor render failed for ${productionId}: ${error.message}`);
        return this.setRenderState(productionId, {
          status: 'failed', message: 'A montagem falhou', error: summarizeError(error), finishedAt: new Date().toISOString()
        });
      }
    ).finally(() => { this.activeId = null; });
    return state;
  }

  async markInterruptedRenders() {
    for (const { productionId, renderState } of await this.db.listEditorRenderStates()) {
      if (renderState.status === 'running') {
        await this.db.saveEditorRenderState(productionId, {
          ...renderState, status: 'interrupted', message: 'O app foi reiniciado durante a montagem.'
        });
      }
    }
  }

  async exportProject(productionId) {
    const editor = await this.getEditor(productionId);
    if (!editor.canRender) throw new EditorError(editor.blockedReason);
    const { library } = await this.load(productionId);
    const folder = await exportForCapCut({
      project: editor.project,
      library: { assets: library.assets, narration: library.narration },
      texts: library.texts,
      title: editor.title,
      exportRoot: this.exportRoot
    });
    await this.db.saveEditorExportPath(productionId, folder);
    return { path: folder };
  }

  async outputFolder(productionId, target) {
    if (target === 'export') return (await this.db.getEditorProject(productionId))?.exportPath || null;
    const output = (await this.getRenderState(productionId)).outputPath;
    return output && await fs.access(output).then(() => true, () => false) ? path.dirname(output) : null;
  }
}

module.exports = { EditorService };
