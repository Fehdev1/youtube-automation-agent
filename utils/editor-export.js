// Exports an editor project as a numbered folder to drag into CapCut, plus
// 05_ordem_e_tempos.txt telling where each image goes on the timeline.
const fs = require('fs').promises;
const path = require('path');
const { blockTimes } = require('./editor-project');

const ZOOM_LABEL = { in: 'zoom aproximar', out: 'zoom afastar', none: 'sem zoom' };
const TRANSITION_LABEL = { cut: 'corte', fade: 'esmaecer' };

function slugTitle(title) {
  return String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'video';
}

function clock(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

async function exportForCapCut({ project, library, texts, title, exportRoot }) {
  const folder = path.join(exportRoot, slugTitle(title));
  await fs.rm(folder, { recursive: true, force: true });
  await fs.mkdir(path.join(folder, 'imagens'), { recursive: true });
  const find = id => library.assets.find(asset => asset.id === id);

  await fs.copyFile(library.narration.path, path.join(folder, `01_narracao${path.extname(library.narration.path)}`));
  if (texts.captions) await fs.writeFile(path.join(folder, '02_legenda.srt'), texts.captions);
  await fs.writeFile(path.join(folder, '03_roteiro.txt'), texts.script || '');

  const times = blockTimes(project);
  const order = [];
  for (const [index, block] of project.blocks.entries()) {
    const asset = find(block.assetId);
    const number = String(index + 1).padStart(3, '0');
    await fs.copyFile(asset.path, path.join(folder, 'imagens', `${number}_${asset.name}`));
    order.push(`${number} · ${clock(times[index].start)} → ${clock(times[index].end)} · ${asset.name} · ${ZOOM_LABEL[block.zoom]} · ${TRANSITION_LABEL[block.transition]}`);
  }
  await fs.writeFile(path.join(folder, '05_ordem_e_tempos.txt'), `${order.join('\n')}\n`);

  if (project.music) {
    const music = find(project.music.assetId);
    await fs.mkdir(path.join(folder, 'musica'), { recursive: true });
    await fs.copyFile(music.path, path.join(folder, 'musica', music.name));
  }

  const credits = [...new Set(project.blocks.map(block => find(block.assetId)?.credit).filter(Boolean))];
  const youtube = [
    'TÍTULO', texts.title, '',
    'DESCRIÇÃO', texts.description, '',
    'TAGS', texts.tags.join(', '), '',
    'CRÉDITOS DAS IMAGENS', ...(credits.length ? credits : ['(nenhum crédito necessário)'])
  ];
  await fs.writeFile(path.join(folder, '04_youtube.txt'), `${youtube.join('\n')}\n`);
  return folder;
}

module.exports = { exportForCapCut, slugTitle };
