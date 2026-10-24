// Media editor project model: a single narration with image/video blocks laid
// over it, plus optional background music. Pure functions, no I/O.

const FADE_SECONDS = 0.5;
const ZOOM_MAX = 1.12;
const ZOOMS = ['none', 'in', 'out'];
const TRANSITIONS = ['cut', 'fade'];
const MIN_BLOCK_SECONDS = 1;
const SENTENCE_END = /[.!?…]["')\]]*$/;

class EditorError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const round = value => Math.round(value * 1000) / 1000;

function parseSRT(text) {
  const time = value => {
    const [h, m, rest] = value.split(':');
    const [s, ms] = rest.split(/[,.]/);
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms || 0) / 1000;
  };
  return String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map(chunk => {
    const lines = chunk.trim().split('\n');
    const timing = lines.findIndex(line => line.includes('-->'));
    if (timing === -1) return null;
    const [start, end] = lines[timing].split('-->').map(part => time(part.trim()));
    return { start, end, text: lines.slice(timing + 1).join(' ').trim() };
  }).filter(Boolean);
}

// Spreads the images evenly over the narration, moving each cut to the
// nearest sentence end so no image changes mid-sentence.
function buildInitialProject({ narrationDuration, captions = [], imageAssetIds = [] }) {
  const total = Number(narrationDuration) || 0;
  const count = Math.min(imageAssetIds.length, Math.floor(total / MIN_BLOCK_SECONDS));
  const sentenceEnds = captions.filter(c => SENTENCE_END.test(c.text.trim())).map(c => c.end);

  const cuts = [];
  let previous = 0;
  for (let k = 1; k < count; k++) {
    const target = (k * total) / count;
    const fits = end => end - previous >= MIN_BLOCK_SECONDS && total - end >= (count - k) * MIN_BLOCK_SECONDS;
    const nearest = sentenceEnds
      .filter(end => fits(end) && Math.abs(end - target) <= total / count / 2)
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    previous = nearest ?? target;
    cuts.push(previous);
  }

  const edges = [0, ...cuts, total];
  const blocks = imageAssetIds.slice(0, count).map((assetId, index) => ({
    id: `b${index + 1}`,
    assetId,
    duration: round(edges[index + 1] - edges[index]),
    zoom: index % 2 === 0 ? 'in' : 'out',
    transition: index === 0 ? 'cut' : 'fade'
  }));

  return {
    schema: 1,
    resolution: '1920x1080',
    fps: 30,
    narration: { assetId: 'narration', duration: round(total) },
    music: null,
    blocks
  };
}

// Validates a project sent by the editor and returns a clean copy whose
// blocks cover the whole narration (the last block absorbs the difference).
function normalizeProject(project, { narrationDuration, kinds }) {
  const total = round(Number(narrationDuration) || 0);
  if (!project || !Array.isArray(project.blocks)) throw new EditorError('Projeto inválido: faltam os blocos.');

  const blocks = project.blocks.map((block, index) => {
    const label = `Bloco ${index + 1}`;
    const kind = kinds.get(block.assetId);
    if (!kind) throw new EditorError(`${label}: arquivo não encontrado na biblioteca.`);
    if (kind !== 'image' && kind !== 'video') throw new EditorError(`${label}: use uma imagem ou um vídeo.`);
    const duration = Number(block.duration);
    if (!Number.isFinite(duration) || duration < MIN_BLOCK_SECONDS) {
      throw new EditorError(`${label}: a duração mínima é de ${MIN_BLOCK_SECONDS} segundo.`);
    }
    if (!ZOOMS.includes(block.zoom)) throw new EditorError(`${label}: zoom inválido.`);
    if (!TRANSITIONS.includes(block.transition)) throw new EditorError(`${label}: transição inválida.`);
    return {
      id: String(block.id || `b${index + 1}`),
      assetId: block.assetId,
      duration: round(duration),
      zoom: block.zoom,
      transition: index === 0 ? 'cut' : block.transition
    };
  });

  if (blocks.length) {
    const others = blocks.slice(0, -1).reduce((sum, block) => sum + block.duration, 0);
    const last = blocks[blocks.length - 1];
    const fitted = round(total - others);
    if (fitted < MIN_BLOCK_SECONDS) throw new EditorError('Os blocos passam da duração da narração.');
    last.duration = fitted;
  }

  let music = null;
  if (project.music) {
    const { assetId, start, end, volume, duck } = project.music;
    if (kinds.get(assetId) !== 'audio') throw new EditorError('Música: escolha um arquivo de áudio.');
    if (!(Number(start) >= 0 && Number(end) > Number(start))) throw new EditorError('Música: início e fim inválidos.');
    if (!(Number(volume) >= 0 && Number(volume) <= 1)) throw new EditorError('Música: o volume vai de 0 a 1.');
    music = { assetId, start: round(Number(start)), end: round(Number(end)), volume: Number(volume), duck: Boolean(duck) };
  }

  return { schema: 1, resolution: '1920x1080', fps: 30, narration: { assetId: 'narration', duration: total }, music, blocks };
}

function blockTimes(project) {
  let start = 0;
  return project.blocks.map(block => {
    const time = { id: block.id, start: round(start), end: round(start + block.duration) };
    start += block.duration;
    return time;
  });
}

module.exports = {
  EditorError, FADE_SECONDS, ZOOM_MAX, ZOOMS, TRANSITIONS, MIN_BLOCK_SECONDS,
  parseSRT, buildInitialProject, normalizeProject, blockTimes
};
