/* Editor de mídia: video list, library, live preview, timeline, MP4 render and CapCut export.
   Relies on app.js globals: api, showToast, escapeHTML, switchView. */
(() => {
  const FADE = 0.5;
  const ZOOM_MAX = 1.12;
  const HISTORY_LIMIT = 50;
  const ZOOM_LABEL = { none: 'Nenhum', in: 'Aproximar lento', out: 'Afastar lento' };
  const TRANSITION_LABEL = { cut: 'Corte seco', fade: 'Esmaecer (0,5 s)' };

  const ed = {
    pid: null, data: null, project: null, version: null, assets: new Map(),
    selected: null, past: [], future: [], saveTimer: null, saving: false, conflict: false,
    pxPerSec: 8, playing: false, raf: null, poll: null, captions: [], tab: 'images'
  };

  const root = () => document.querySelector('#editor-view');
  const q = selector => root().querySelector(selector);
  const assetUrl = id => `/api/editor/${encodeURIComponent(ed.pid)}/assets/${encodeURIComponent(id)}`;
  const total = () => ed.project.narration.duration;
  const clone = value => JSON.parse(JSON.stringify(value));
  const clock = seconds => {
    const s = Math.max(0, seconds || 0);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  const round = value => Math.round(value * 1000) / 1000;

  function parseSRT(text) {
    const time = value => {
      const [h, m, rest] = value.trim().split(':');
      const [s, ms] = rest.split(/[,.]/);
      return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms || 0) / 1000;
    };
    return String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map(chunk => {
      const lines = chunk.trim().split('\n');
      const i = lines.findIndex(line => line.includes('-->'));
      if (i === -1) return null;
      const [start, end] = lines[i].split('-->').map(time);
      return { start, end, text: lines.slice(i + 1).join(' ') };
    }).filter(Boolean);
  }

  function times() {
    let start = 0;
    return ed.project.blocks.map(block => {
      const item = { block, start, end: start + block.duration };
      start += block.duration;
      return item;
    });
  }

  /* ---------- video list ---------- */
  async function showList() {
    stopPlayback();
    clearInterval(ed.poll);
    ed.pid = null;
    root().innerHTML = `<div class="section-intro"><div><h2>Editor de mídia</h2><p>Escolha um vídeo para montar, ajustar e exportar.</p></div></div><div class="ed-list" id="ed-list"><div class="empty">Carregando vídeos…</div></div>`;
    try {
      const { result } = await api('/api/editor/productions');
      q('#ed-list').innerHTML = result.length ? result.map(item => `
        <button class="ed-list-item" data-ed-open="${escapeHTML(item.id)}">
          <strong>${escapeHTML(item.title)}</strong>
          <span class="meta-line">${escapeHTML(item.createdAt || '')} · ${item.hasNarration ? 'com narração' : 'sem narração'}${item.hasProject ? ' · já editado' : ''}</span>
        </button>`).join('') : '<div class="empty">Nenhum vídeo gerado ainda.</div>';
    } catch (error) {
      q('#ed-list').innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
    }
  }

  /* ---------- workspace ---------- */
  async function openEditor(productionId) {
    // Set the id first: switching to the tab with no id would load the video list over the editor.
    ed.pid = productionId;
    if (typeof window.switchView === 'function' && ui.currentView !== 'editor') window.switchView('editor');
    stopPlayback();
    ed.selected = null;
    ed.past = [];
    ed.future = [];
    ed.conflict = false;
    root().innerHTML = '<div class="empty">Abrindo o editor…</div>';
    try {
      const { result } = await api(`/api/editor/${encodeURIComponent(productionId)}`);
      ed.data = result;
      ed.project = result.project;
      ed.version = result.version;
      ed.assets = new Map(result.library.map(asset => [asset.id, asset]));
      ed.captions = parseSRT(result.texts.captions);
      ed.pxPerSec = Math.max(2, Math.min(40, 1100 / Math.max(1, total())));
      renderWorkspace();
      if (result.render.status === 'running') pollRender();
    } catch (error) {
      root().innerHTML = `<div class="empty">${escapeHTML(error.message)}</div>`;
    }
  }

  function renderWorkspace() {
    root().innerHTML = `
      <div class="ed-head">
        <button class="text-button" data-ed-back>← Vídeos</button>
        <div class="ed-title"><h2>${escapeHTML(ed.data.title)}</h2></div>
        <span class="ed-save meta-line" id="ed-save">Tudo salvo</span>
        <div class="ed-actions">
          <button class="button secondary" data-ed-export>Exportar para o CapCut</button>
          <button class="button primary" data-ed-render>Gerar MP4</button>
        </div>
      </div>
      <div class="ed-alert hidden" id="ed-alert"></div>
      <div class="ed-render hidden" id="ed-render"></div>
      <div class="ed-grid">
        <section class="panel ed-library">
          <div class="ed-tabs" role="tablist">
            <button data-ed-tab="images">Imagens</button><button data-ed-tab="audio">Áudio</button><button data-ed-tab="texts">Textos</button>
          </div>
          <div id="ed-library-body" class="ed-library-body"></div>
          <label class="ed-drop" id="ed-drop">＋ Enviar do computador<small>Imagens, vídeos MP4 e músicas · arraste aqui</small>
            <input type="file" id="ed-upload" multiple accept=".jpg,.jpeg,.png,.webp,.mp4,.mp3,.wav" hidden></label>
        </section>
        <section class="panel ed-preview">
          <div class="ed-stage" id="ed-stage"><div class="ed-caption" id="ed-caption"></div></div>
          <div class="ed-transport">
            <button class="button secondary small" data-ed-play>▶ Tocar</button>
            <input type="range" id="ed-seek" min="0" max="${total()}" step="0.1" value="0" aria-label="Posição">
            <span class="meta-line" id="ed-clock">00:00 / ${clock(total())}</span>
          </div>
        </section>
        <section class="panel ed-props" id="ed-props"></section>
      </div>
      <section class="panel ed-timeline">
        <div class="ed-timeline-head">
          <strong>Linha do tempo</strong>
          <span class="meta-line">Arraste para reordenar · solte uma imagem sobre um bloco para trocar · puxe a borda para mudar a duração</span>
          <span class="ed-zoom"><button class="text-button" data-ed-zoom="-1" aria-label="Diminuir zoom">−</button><button class="text-button" data-ed-zoom="1" aria-label="Aumentar zoom">＋</button></span>
        </div>
        <div class="ed-scroll" id="ed-scroll">
          <div class="ed-tracks" id="ed-tracks"></div>
        </div>
      </section>
      <audio id="ed-narration" preload="auto" src="${ed.data.library.some(a => a.id === 'narration') ? assetUrl('narration') : ''}"></audio>
      <audio id="ed-music" preload="auto"></audio>`;
    renderLibrary();
    renderStage();
    renderTimeline();
    renderProps();
    renderAlert();
    renderRenderState(ed.data.render);
    drawWaveform();
  }

  function renderAlert() {
    const alert = q('#ed-alert');
    const reason = ed.conflict ? 'Este projeto foi alterado em outra aba. Recarregue para continuar.' : ed.data.blockedReason;
    alert.classList.toggle('hidden', !reason);
    alert.innerHTML = reason ? `${escapeHTML(reason)}${ed.conflict ? ' <button class="text-button" data-ed-reload>Recarregar</button>' : ''}` : '';
    const blocked = Boolean(reason);
    q('[data-ed-render]').disabled = blocked;
    q('[data-ed-export]').disabled = blocked;
  }

  /* ---------- library ---------- */
  function renderLibrary() {
    root().querySelectorAll('[data-ed-tab]').forEach(tab => tab.classList.toggle('active', tab.dataset.edTab === ed.tab));
    const body = q('#ed-library-body');
    const list = [...ed.assets.values()];
    if (ed.tab === 'images') {
      const visuals = list.filter(asset => asset.kind === 'image' || asset.kind === 'video');
      body.innerHTML = visuals.length ? `<div class="ed-thumbs">${visuals.map(asset => `
        <div class="ed-thumb" draggable="true" data-ed-asset="${escapeHTML(asset.id)}" title="${escapeHTML(asset.credit || asset.name)}">
          ${asset.kind === 'video' ? `<video src="${assetUrl(asset.id)}#t=0.5" muted preload="metadata"></video><span class="ed-badge">vídeo</span>` : `<img src="${assetUrl(asset.id)}" alt="" loading="lazy">`}
          <small>${escapeHTML(asset.name)}</small>
        </div>`).join('')}</div>` : '<div class="empty">Nenhuma imagem. Envie do computador.</div>';
    } else if (ed.tab === 'audio') {
      const audio = list.filter(asset => asset.kind === 'audio');
      body.innerHTML = audio.map(asset => `
        <div class="ed-audio">
          <strong>${asset.id === 'narration' ? '🎙️ Narração' : `🎵 ${escapeHTML(asset.name)}`}</strong>
          <audio controls preload="none" src="${assetUrl(asset.id)}"></audio>
          ${asset.id === 'narration' ? '' : `<button class="text-button" data-ed-music="${escapeHTML(asset.id)}">${ed.project.music?.assetId === asset.id ? '✓ Em uso como música' : 'Usar como música de fundo'}</button>`}
        </div>`).join('') || '<div class="empty">Nenhum áudio.</div>';
    } else {
      const t = ed.data.texts;
      const field = (label, value, key) => `<div class="ed-text"><div class="ed-text-head"><strong>${label}</strong><button class="text-button" data-ed-copy="${key}">Copiar</button></div><pre>${escapeHTML(value || '—')}</pre></div>`;
      body.innerHTML = field('Título', t.title, 'title') + field('Descrição', t.description, 'description')
        + field('Tags', (t.tags || []).join(', '), 'tags') + field('Roteiro', t.script, 'script') + field('Legenda (.srt)', t.captions, 'captions');
    }
  }

  async function uploadFiles(files) {
    for (const file of files) {
      try {
        showToast(`Enviando ${file.name}…`);
        const { result } = await api(`/api/editor/${encodeURIComponent(ed.pid)}/uploads`, {
          method: 'POST', body: file,
          headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }
        });
        ed.assets.set(result.id, result);
        ed.data.library.push(result);
        showToast(`${file.name} adicionado à biblioteca.`);
      } catch (error) {
        showToast(`${file.name}: ${error.message}`, 'error');
      }
    }
    renderLibrary();
  }

  /* ---------- editing, history and autosave ---------- */
  function change(mutator) {
    const before = clone(ed.project);
    mutator(ed.project);
    ed.past.push(before);
    if (ed.past.length > HISTORY_LIMIT) ed.past.shift();
    ed.future = [];
    afterChange();
  }

  function afterChange() {
    ed.project.blocks.forEach((block, i) => { if (i === 0) block.transition = 'cut'; });
    renderStage();
    renderTimeline();
    renderProps();
    scheduleSave();
  }

  function undo(redo = false) {
    const from = redo ? ed.future : ed.past;
    const to = redo ? ed.past : ed.future;
    if (!from.length) return;
    to.push(clone(ed.project));
    ed.project = from.pop();
    afterChange();
  }

  function scheduleSave() {
    if (ed.conflict) return;
    q('#ed-save').textContent = 'Salvando…';
    clearTimeout(ed.saveTimer);
    ed.saveTimer = setTimeout(save, 1000);
  }

  async function save() {
    if (ed.saving) return scheduleSave();
    ed.saving = true;
    try {
      const { result } = await api(`/api/editor/${encodeURIComponent(ed.pid)}`, {
        method: 'PUT', body: JSON.stringify({ version: ed.version, project: ed.project })
      });
      ed.version = result.version;
      const durationsChanged = result.project.blocks.some((block, i) => block.duration !== ed.project.blocks[i]?.duration);
      ed.project = result.project;
      if (durationsChanged) renderTimeline();
      q('#ed-save').textContent = 'Tudo salvo';
    } catch (error) {
      if (error.message && /outra aba/.test(error.message)) {
        ed.conflict = true;
        renderAlert();
      }
      q('#ed-save').textContent = 'Não salvo';
      showToast(error.message, 'error');
    } finally {
      ed.saving = false;
    }
  }

  // Duration changes are absorbed by the last block (or the one before, when resizing the last).
  function resizeBlock(index, newDuration) {
    change(project => {
      const blocks = project.blocks;
      const block = blocks[index];
      const absorber = index === blocks.length - 1 ? blocks[index - 1] : blocks[blocks.length - 1];
      if (!absorber) return;
      let delta = Math.max(1, newDuration) - block.duration;
      if (absorber.duration - delta < 1) delta = absorber.duration - 1;
      block.duration = round(block.duration + delta);
      absorber.duration = round(absorber.duration - delta);
    });
  }

  function addBlock(assetId) {
    change(project => {
      const blocks = project.blocks;
      const last = blocks[blocks.length - 1];
      if (last && last.duration < 2) return showToast('Encurte algum bloco antes de adicionar outro.', 'error');
      const duration = last ? round(last.duration / 2) : total();
      if (last) last.duration = round(last.duration - duration);
      blocks.push({ id: `b${Date.now().toString(36)}`, assetId, duration, zoom: 'in', transition: blocks.length ? 'fade' : 'cut' });
    });
  }

  function removeBlock(id) {
    change(project => {
      const blocks = project.blocks;
      const index = blocks.findIndex(block => block.id === id);
      if (index === -1 || blocks.length === 1) return;
      const neighbor = blocks[index - 1] || blocks[index + 1];
      neighbor.duration = round(neighbor.duration + blocks[index].duration);
      blocks.splice(index, 1);
    });
    ed.selected = null;
    renderProps();
  }

  /* ---------- properties ---------- */
  function renderProps() {
    const panel = q('#ed-props');
    if (!panel) return;
    const index = ed.project.blocks.findIndex(block => block.id === ed.selected);
    if (index === -1) {
      const music = ed.project.music;
      panel.innerHTML = `<p class="eyebrow">VÍDEO TODO</p>
        <label><span>Resolução</span><input value="1920 × 1080 (Full HD)" disabled></label>
        ${music ? `
          <label><span>Música: ${escapeHTML(ed.assets.get(music.assetId)?.name || '')}</span>
            <input type="range" min="0" max="1" step="0.05" value="${music.volume}" data-ed-music-field="volume"><small>Volume: ${Math.round(music.volume * 100)}%</small></label>
          <label class="toggle"><input type="checkbox" data-ed-music-field="duck" ${music.duck ? 'checked' : ''}><span></span> Abaixar a música durante a narração</label>
          <div class="form-grid two">
            <label><span>Início na música (s)</span><input type="number" min="0" step="0.5" value="${music.start}" data-ed-music-field="start"></label>
            <label><span>Fim na música (s)</span><input type="number" min="0.5" step="0.5" value="${music.end}" data-ed-music-field="end"></label>
          </div>
          <button class="text-button danger-text" data-ed-music-remove>Remover música</button>`
        : '<p class="meta-line">Sem música. Na aba Áudio, envie uma música e clique em "Usar como música de fundo".</p>'}
        <p class="meta-line">Clique num bloco da linha do tempo para ajustar duração, zoom e transição.</p>`;
      return;
    }
    const block = ed.project.blocks[index];
    const asset = ed.assets.get(block.assetId);
    panel.innerHTML = `<p class="eyebrow">BLOCO ${index + 1}</p>
      <strong class="ed-prop-name">${escapeHTML(asset?.name || 'arquivo não encontrado')}</strong>
      <label><span>Duração (s)</span><input type="number" min="1" step="0.1" value="${block.duration}" data-ed-field="duration"></label>
      <label><span>Zoom</span><select data-ed-field="zoom">${Object.entries(ZOOM_LABEL).map(([v, l]) => `<option value="${v}" ${block.zoom === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label><span>Transição de entrada</span><select data-ed-field="transition" ${index === 0 ? 'disabled' : ''}>${Object.entries(TRANSITION_LABEL).map(([v, l]) => `<option value="${v}" ${block.transition === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${asset?.credit ? `<small class="meta-line">Crédito: ${escapeHTML(asset.credit)}</small>` : ''}
      <div class="form-actions"><button class="text-button" data-ed-deselect>Ajustes do vídeo</button><button class="text-button danger-text" data-ed-remove="${escapeHTML(block.id)}">Remover bloco</button></div>`;
  }

  /* ---------- timeline ---------- */
  function renderTimeline() {
    const tracks = q('#ed-tracks');
    if (!tracks) return;
    const width = Math.round(total() * ed.pxPerSec);
    const issues = new Set((ed.data.issues || []).map(issue => issue.blockId));
    const music = ed.project.music;
    tracks.style.width = `${width}px`;
    tracks.innerHTML = `
      <div class="ed-ruler">${Array.from({ length: Math.floor(total() / 10) + 1 }, (_, i) => `<span style="left:${i * 10 * ed.pxPerSec}px">${clock(i * 10)}</span>`).join('')}</div>
      <div class="ed-track ed-track-images" data-ed-track="images">${times().map(({ block }, i) => {
        const asset = ed.assets.get(block.assetId);
        const missing = !asset || issues.has(block.id);
        return `<div class="ed-block ${block.id === ed.selected ? 'selected' : ''} ${missing ? 'missing' : ''}" draggable="true"
            data-ed-block="${escapeHTML(block.id)}" style="width:${Math.max(4, block.duration * ed.pxPerSec)}px">
          ${asset && asset.kind === 'image' ? `<img src="${assetUrl(asset.id)}" alt="" loading="lazy" draggable="false">` : ''}
          <span class="ed-block-label">${missing ? '⚠ arquivo não encontrado' : `${i + 1} · ${block.duration.toFixed(1)}s${block.transition === 'fade' ? ' · esmaecer' : ''}`}</span>
          <span class="ed-handle" data-ed-handle="${i}" aria-label="Mudar duração"></span>
        </div>`;
      }).join('')}</div>
      <div class="ed-track ed-track-narration"><canvas id="ed-wave" height="36"></canvas><span class="ed-track-label">🎙️ narração</span></div>
      <div class="ed-track ed-track-music">${music ? `<div class="ed-music-bar">🎵 ${escapeHTML(ed.assets.get(music.assetId)?.name || 'música')} · volume ${Math.round(music.volume * 100)}%${music.duck ? ' · abaixa na fala' : ''}</div>` : '<span class="ed-track-label">🎵 sem música</span>'}</div>
      <div class="ed-playhead" id="ed-playhead"></div>`;
    drawWaveform(true);
    updatePlayhead();
  }

  let waveCache = null;
  async function drawWaveform(fromCache = false) {
    const canvas = q('#ed-wave');
    if (!canvas || !ed.data.library.some(a => a.id === 'narration')) return;
    canvas.width = Math.min(16000, Math.round(total() * ed.pxPerSec));
    if (!waveCache || waveCache.pid !== ed.pid) {
      if (fromCache) return;
      try {
        const buffer = await (await fetch(assetUrl('narration'))).arrayBuffer();
        const audio = await new (window.AudioContext || window.webkitAudioContext)().decodeAudioData(buffer);
        waveCache = { pid: ed.pid, data: audio.getChannelData(0) };
      } catch (_error) { return; }
    }
    const ctx = canvas.getContext('2d');
    const { data } = waveCache;
    const step = Math.max(1, Math.floor(data.length / canvas.width));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(110,168,255,.55)';
    for (let x = 0; x < canvas.width; x++) {
      let peak = 0;
      for (let i = x * step; i < (x + 1) * step && i < data.length; i += 8) peak = Math.max(peak, Math.abs(data[i]));
      const h = Math.max(1, peak * canvas.height);
      ctx.fillRect(x, (canvas.height - h) / 2, 1, h);
    }
  }

  /* ---------- preview ---------- */
  function renderStage() {
    const stage = q('#ed-stage');
    if (!stage) return;
    stage.querySelectorAll('.ed-layer').forEach(layer => layer.remove());
    for (const { block } of times()) {
      const asset = ed.assets.get(block.assetId);
      if (!asset) continue;
      const layer = document.createElement(asset.kind === 'video' ? 'video' : 'img');
      layer.className = 'ed-layer';
      layer.dataset.block = block.id;
      layer.src = assetUrl(asset.id);
      if (asset.kind === 'video') { layer.muted = true; layer.loop = true; layer.playsInline = true; }
      stage.insertBefore(layer, q('#ed-caption'));
    }
    const music = ed.project.music;
    const musicEl = q('#ed-music');
    if (music && musicEl && !musicEl.src.endsWith(encodeURIComponent(music.assetId))) musicEl.src = assetUrl(music.assetId);
    if (!music && musicEl) musicEl.removeAttribute('src');
    paint(currentTime());
  }

  const currentTime = () => q('#ed-narration')?.currentTime || 0;

  function paint(t) {
    const list = times();
    const layers = new Map([...root().querySelectorAll('.ed-layer')].map(layer => [layer.dataset.block, layer]));
    list.forEach(({ block, start, end }, i) => {
      const layer = layers.get(block.id);
      if (!layer) return;
      const next = list[i + 1];
      const fadeOut = next?.block.transition === 'fade' && t >= end - FADE && t < end;
      const fadeIn = block.transition === 'fade' && t >= start - FADE && t < start;
      let opacity = t >= start && t < end ? 1 : 0;
      if (fadeIn) opacity = (t - (start - FADE)) / FADE;
      if (fadeOut) opacity = 1;
      const local = Math.min(1, Math.max(0, (t - start) / block.duration));
      const scale = block.zoom === 'in' ? 1 + (ZOOM_MAX - 1) * local : block.zoom === 'out' ? ZOOM_MAX - (ZOOM_MAX - 1) * local : 1;
      layer.style.opacity = String(opacity);
      layer.style.zIndex = fadeIn ? 2 : 1;
      layer.style.transform = `scale(${scale})`;
      if (layer.tagName === 'VIDEO') {
        if (opacity > 0 && ed.playing && layer.paused) layer.play().catch(() => {});
        if (opacity === 0 && !layer.paused) layer.pause();
      }
    });
    const caption = ed.captions.find(c => t >= c.start && t < c.end);
    const captionEl = q('#ed-caption');
    if (captionEl) captionEl.textContent = caption ? caption.text : '';
    const seek = q('#ed-seek');
    if (seek && document.activeElement !== seek) seek.value = t;
    const clockEl = q('#ed-clock');
    if (clockEl) clockEl.textContent = `${clock(t)} / ${clock(total())}`;
    syncMusic(t);
    updatePlayhead();
  }

  function syncMusic(t) {
    const music = ed.project.music;
    const el = q('#ed-music');
    if (!music || !el?.src) return;
    const narrationOn = ed.captions.some(c => t >= c.start && t < c.end);
    el.volume = Math.min(1, music.volume * (music.duck && narrationOn ? 0.35 : 1));
    const target = music.start + t;
    if (target >= music.end) { el.pause(); return; }
    if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target;
    if (ed.playing && el.paused) el.play().catch(() => {});
    if (!ed.playing && !el.paused) el.pause();
  }

  function updatePlayhead() {
    const head = q('#ed-playhead');
    if (head) head.style.left = `${currentTime() * ed.pxPerSec}px`;
  }

  function tick() {
    paint(currentTime());
    if (ed.playing) ed.raf = requestAnimationFrame(tick);
  }

  function togglePlay() {
    const narration = q('#ed-narration');
    if (!narration?.src) return showToast('Este vídeo não tem narração.', 'error');
    ed.playing = !ed.playing;
    q('[data-ed-play]').textContent = ed.playing ? '❚❚ Pausar' : '▶ Tocar';
    if (ed.playing) { narration.play(); tick(); } else { stopPlayback(); }
  }

  function stopPlayback() {
    ed.playing = false;
    cancelAnimationFrame(ed.raf);
    root()?.querySelectorAll('audio, video').forEach(media => media.pause());
    const button = root()?.querySelector('[data-ed-play]');
    if (button) button.textContent = '▶ Tocar';
  }

  function seek(t) {
    const narration = q('#ed-narration');
    if (narration) narration.currentTime = Math.max(0, Math.min(total(), t));
    paint(currentTime());
  }

  /* ---------- render & export ---------- */
  function renderRenderState(state) {
    const box = q('#ed-render');
    if (!box || !state || state.status === 'idle') return box?.classList.add('hidden');
    box.classList.remove('hidden');
    box.className = `ed-render ${state.status}`;
    if (state.status === 'running') {
      box.innerHTML = `<strong>${escapeHTML(state.message || 'Montando…')}</strong><div class="progress"><i style="width:${state.percent || 0}%"></i></div><span class="meta-line">${state.percent || 0}% · você pode continuar editando; a montagem usa a versão salva no início.</span>`;
    } else if (state.status === 'completed') {
      box.innerHTML = `<strong>✓ Vídeo pronto</strong><span class="meta-line">${escapeHTML(state.outputPath || '')}</span>
        <span class="ed-render-actions"><a class="button secondary small" href="${assetUrl('output')}" target="_blank" rel="noopener">Assistir</a><button class="button secondary small" data-ed-folder="render">Abrir pasta</button></span>`;
    } else {
      box.innerHTML = `<strong>${state.status === 'interrupted' ? 'A montagem foi interrompida' : '× A montagem falhou'}</strong><span class="meta-line">${escapeHTML(state.error || state.message || '')}</span>
        <span class="ed-render-actions"><button class="button secondary small" data-ed-render>Tentar de novo</button></span>`;
    }
  }

  function pollRender() {
    clearInterval(ed.poll);
    const pid = ed.pid;
    ed.poll = setInterval(async () => {
      if (ed.pid !== pid) return clearInterval(ed.poll);
      try {
        const { result } = await api(`/api/editor/${encodeURIComponent(pid)}/render`);
        renderRenderState(result);
        if (result.status !== 'running') {
          clearInterval(ed.poll);
          showToast(result.status === 'completed' ? 'Vídeo pronto!' : 'A montagem não terminou.', result.status === 'completed' ? 'success' : 'error');
        }
      } catch (_error) { /* try again on the next tick */ }
    }, 1000);
  }

  async function startRender() {
    clearTimeout(ed.saveTimer);
    await save();
    try {
      const { result } = await api(`/api/editor/${encodeURIComponent(ed.pid)}/render`, { method: 'POST' });
      renderRenderState(result);
      pollRender();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function exportCapCut() {
    clearTimeout(ed.saveTimer);
    await save();
    try {
      const { result } = await api(`/api/editor/${encodeURIComponent(ed.pid)}/export`, { method: 'POST' });
      const box = q('#ed-render');
      box.className = 'ed-render completed';
      box.innerHTML = `<strong>✓ Pasta para o CapCut pronta</strong><span class="meta-line">${escapeHTML(result.path)}</span><span class="ed-render-actions"><button class="button secondary small" data-ed-folder="export">Abrir pasta</button></span>`;
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  /* ---------- events ---------- */
  document.addEventListener('click', async event => {
    if (!root()?.contains(event.target) && !event.target.closest('[data-open-editor]')) return;
    const t = event.target;
    const openFromReview = t.closest('[data-open-editor]');
    if (openFromReview) { t.closest('dialog')?.close(); return openEditor(openFromReview.dataset.openEditor); }
    const open = t.closest('[data-ed-open]');
    if (open) return openEditor(open.dataset.edOpen);
    if (t.closest('[data-ed-back]')) return showList();
    if (t.closest('[data-ed-reload]')) return openEditor(ed.pid);
    const tab = t.closest('[data-ed-tab]');
    if (tab) { ed.tab = tab.dataset.edTab; return renderLibrary(); }
    if (t.closest('[data-ed-play]')) return togglePlay();
    if (t.closest('[data-ed-render]')) return startRender();
    if (t.closest('[data-ed-export]')) return exportCapCut();
    const folder = t.closest('[data-ed-folder]');
    if (folder) {
      return api(`/api/editor/${encodeURIComponent(ed.pid)}/open-folder`, { method: 'POST', body: JSON.stringify({ target: folder.dataset.edFolder }) })
        .catch(error => showToast(error.message, 'error'));
    }
    const zoom = t.closest('[data-ed-zoom]');
    if (zoom) { ed.pxPerSec = Math.max(1, Math.min(80, ed.pxPerSec * (zoom.dataset.edZoom === '1' ? 1.5 : 1 / 1.5))); return renderTimeline(); }
    const copy = t.closest('[data-ed-copy]');
    if (copy) {
      const value = copy.dataset.edCopy === 'tags' ? ed.data.texts.tags.join(', ') : ed.data.texts[copy.dataset.edCopy];
      return navigator.clipboard.writeText(value || '').then(() => showToast('Copiado.'), () => showToast('Não foi possível copiar.', 'error'));
    }
    const music = t.closest('[data-ed-music]');
    if (music) {
      change(project => { project.music = { assetId: music.dataset.edMusic, start: 0, end: total(), volume: 0.25, duck: true }; });
      return renderLibrary();
    }
    if (t.closest('[data-ed-music-remove]')) { change(project => { project.music = null; }); return renderLibrary(); }
    if (t.closest('[data-ed-deselect]')) { ed.selected = null; renderTimeline(); return renderProps(); }
    const remove = t.closest('[data-ed-remove]');
    if (remove) return removeBlock(remove.dataset.edRemove);
    const block = t.closest('[data-ed-block]');
    if (block && !t.closest('[data-ed-handle]')) {
      ed.selected = block.dataset.edBlock;
      const item = times().find(entry => entry.block.id === ed.selected);
      if (item && !ed.playing) seek(item.start + 0.01);
      renderTimeline();
      return renderProps();
    }
    const scroll = t.closest('#ed-scroll');
    if (scroll && !block) {
      const rect = q('#ed-tracks').getBoundingClientRect();
      seek((event.clientX - rect.left) / ed.pxPerSec);
    }
  });

  document.addEventListener('change', event => {
    if (!root()?.contains(event.target)) return;
    const t = event.target;
    if (t.id === 'ed-upload') { uploadFiles([...t.files]); t.value = ''; return; }
    const field = t.dataset.edField;
    if (field) {
      const index = ed.project.blocks.findIndex(block => block.id === ed.selected);
      if (index === -1) return;
      if (field === 'duration') return resizeBlock(index, Number(t.value));
      return change(project => { project.blocks[index][field] = t.value; });
    }
    const musicField = t.dataset.edMusicField;
    if (musicField && ed.project.music) {
      change(project => {
        project.music[musicField] = musicField === 'duck' ? t.checked : Number(t.value);
        if (project.music.end <= project.music.start) project.music.end = project.music.start + 1;
      });
    }
  });

  document.addEventListener('input', event => {
    if (event.target.id === 'ed-seek') seek(Number(event.target.value));
  });

  // Drag & drop: reorder blocks, swap an image onto a block, add at the end, upload files.
  document.addEventListener('dragstart', event => {
    const block = event.target.closest?.('[data-ed-block]');
    const asset = event.target.closest?.('[data-ed-asset]');
    if (block) event.dataTransfer.setData('text/plain', `block:${block.dataset.edBlock}`);
    else if (asset) event.dataTransfer.setData('text/plain', `asset:${asset.dataset.edAsset}`);
  });
  document.addEventListener('dragover', event => {
    if (event.target.closest?.('[data-ed-track="images"], #ed-drop, .ed-library')) event.preventDefault();
  });
  document.addEventListener('drop', event => {
    if (!root()?.contains(event.target)) return;
    if (event.dataTransfer.files?.length && event.target.closest('.ed-library, #ed-drop')) {
      event.preventDefault();
      return uploadFiles([...event.dataTransfer.files]);
    }
    const payload = event.dataTransfer.getData('text/plain');
    const target = event.target.closest('[data-ed-block]');
    if (!payload || !event.target.closest('[data-ed-track="images"]')) return;
    event.preventDefault();
    const [kind, id] = payload.split(':');
    if (kind === 'asset' && target) {
      return change(project => { project.blocks.find(block => block.id === target.dataset.edBlock).assetId = id; });
    }
    if (kind === 'asset') return addBlock(id);
    if (kind === 'block' && target && target.dataset.edBlock !== id) {
      change(project => {
        const from = project.blocks.findIndex(block => block.id === id);
        const [moved] = project.blocks.splice(from, 1);
        project.blocks.splice(project.blocks.findIndex(block => block.id === target.dataset.edBlock), 0, moved);
      });
    }
  });

  // Resize by dragging a block's right edge.
  document.addEventListener('pointerdown', event => {
    const handle = event.target.closest?.('[data-ed-handle]');
    if (!handle) return;
    event.preventDefault();
    const index = Number(handle.dataset.edHandle);
    const blockEl = handle.closest('[data-ed-block]');
    const startX = event.clientX;
    const startDuration = ed.project.blocks[index].duration;
    const move = e => { blockEl.style.width = `${Math.max(4, (startDuration + (e.clientX - startX) / ed.pxPerSec) * ed.pxPerSec)}px`; };
    const up = e => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      resizeBlock(index, startDuration + (e.clientX - startX) / ed.pxPerSec);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });

  document.addEventListener('keydown', event => {
    if (!ed.pid || ui.currentView !== 'editor' || event.target.closest?.('input, textarea, select')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey); }
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  });

  // Load the list when the tab is opened from the menu.
  const baseSwitch = window.switchView;
  window.switchView = function (view) {
    const result = baseSwitch(view);
    if (view === 'editor' && !ed.pid) showList();
    if (view !== 'editor') stopPlayback();
    return result;
  };
  window.openEditor = openEditor;
  if (location.hash === '#editor') showList();
})();
