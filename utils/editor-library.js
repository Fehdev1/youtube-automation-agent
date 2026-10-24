// Media library of one production for the editor: every file gets a stable
// assetId, and files are only ever served by that id, never by a browser path.
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { EditorError } = require('./editor-project');

const KINDS = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.mp4': 'video', '.mp3': 'audio', '.wav': 'audio' };
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const ORIGIN_PREFIX = { wikimedia: 'wm', upload: 'up', generated: 'gen' };

const kindOf = name => KINDS[path.extname(name).toLowerCase()] || null;

function assetId(origin, name) {
  const slug = path.basename(name, path.extname(name)).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${ORIGIN_PREFIX[origin]}_${slug}_${hash}`;
}

async function exists(file) {
  try { await fs.access(file); return true; } catch (_error) { return false; }
}

async function readText(file) {
  return file && await exists(file) ? fs.readFile(file, 'utf8') : '';
}

// CREDITOS.txt (written by wikimedia-images.js): blocks of "<file>\n  <credit>\n  <url>".
function parseCredits(text) {
  const credits = new Map();
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const [name, ...rest] = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (name && rest.length) credits.set(name, rest.join(' · '));
  }
  return credits;
}

async function listFolder(folder, origin, credits = new Map()) {
  const names = await fs.readdir(folder).catch(() => []);
  return names.sort().filter(name => kindOf(name)).map(name => ({
    id: assetId(origin, name),
    kind: kindOf(name),
    origin,
    name,
    path: path.join(folder, name),
    credit: credits.get(name) || null
  }));
}

async function buildLibrary(bundle, { dataDir }) {
  const folder = path.join(dataDir, 'assets', bundle.id);
  const credits = parseCredits(await readText(path.join(folder, 'CREDITOS.txt')));
  const assets = [
    ...await listFolder(folder, 'wikimedia', credits),
    ...await listFolder(path.join(folder, 'uploads'), 'upload')
  ];

  for (const visual of bundle.assets?.video?.visualAssets || []) {
    const name = path.basename(visual);
    if (kindOf(name) === 'image' && await exists(visual)) {
      assets.push({ id: assetId('generated', name), kind: 'image', origin: 'generated', name, path: visual, credit: null });
    }
  }

  const audioPath = bundle.assets?.audio?.path;
  const narration = audioPath && kindOf(audioPath) === 'audio' && await exists(audioPath)
    ? { id: 'narration', kind: 'audio', origin: 'narration', name: path.basename(audioPath), path: audioPath, credit: null }
    : null;

  const seo = typeof bundle.seo === 'string' ? JSON.parse(bundle.seo || '{}') : (bundle.seo || {});
  const captionsPath = bundle.assets?.captions?.path && await exists(bundle.assets.captions.path) ? bundle.assets.captions.path : null;
  const texts = {
    script: await readText(bundle.assets?.script?.ttsPath),
    captions: await readText(captionsPath),
    title: seo.title || '',
    description: seo.description || '',
    tags: Array.isArray(seo.tags) ? seo.tags : []
  };
  return { assets, narration, texts, captionsPath };
}

async function saveUpload(productionId, fileName, buffer, { dataDir }) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (!KINDS[extension]) throw new EditorError('Tipo de arquivo não aceito. Use JPG, PNG, WEBP, MP4, MP3 ou WAV.');
  if (!buffer || buffer.length > MAX_UPLOAD_BYTES) throw new EditorError('O arquivo passa do limite de 200 MB.');
  const base = path.basename(String(fileName).replace(/\\/g, '/'), path.extname(fileName))
    .replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(0, 60) || 'arquivo';
  const folder = path.join(dataDir, 'assets', productionId, 'uploads');
  await fs.mkdir(folder, { recursive: true });
  const name = `${base}_${Date.now().toString(36)}${extension}`;
  const file = path.join(folder, name);
  await fs.writeFile(file, buffer);
  return { id: assetId('upload', name), kind: KINDS[extension], origin: 'upload', name, path: file, credit: null };
}

function resolveAssetPath(library, id, dataDir) {
  const asset = id === 'narration' ? library.narration : library.assets.find(item => item.id === id);
  if (!asset) throw new EditorError('Arquivo não encontrado.', 404);
  const relative = path.relative(path.resolve(dataDir), path.resolve(asset.path));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new EditorError('Acesso negado.', 403);
  return asset.path;
}

module.exports = { buildLibrary, saveUpload, resolveAssetPath, kindOf, MAX_UPLOAD_BYTES };
