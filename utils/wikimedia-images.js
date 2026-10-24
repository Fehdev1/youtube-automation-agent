const fs = require('fs').promises;
const path = require('path');

const API_URL = 'https://commons.wikimedia.org/w/api.php';
// Wikimedia asks API clients to identify themselves.
const USER_AGENT = 'youtube-automation-agent/2.11 (https://github.com/darkzOGx/youtube-automation-agent)';
// Licenses that allow commercial use. CC BY and CC BY-SA require attribution,
// which CREDITOS.txt provides for the video description.
const FREE_LICENSE = /^(public domain|pd\b|cc0|cc by(-sa)? \d)/i;
const MIN_WIDTH = 1280;

const stripHtml = value => String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// Searches Wikimedia Commons for freely licensed images, one term at a time
// (the API rate-limits bursts), and downloads up to `max` of them into `directory`.
// Landscape images come first because they fill a 16:9 frame.
async function findFreeImages(terms, directory, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const delayMs = options.delayMs ?? 1000;
  const max = options.max ?? 12;
  const logger = options.logger;

  const termKeys = new Set();
  const uniqueTerms = terms
    .map(term => String(term || '').trim())
    .filter(term => term && !termKeys.has(term.toLowerCase()) && termKeys.add(term.toLowerCase()));

  const perTerm = [];
  for (const term of uniqueTerms) {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));

    let pages = [];
    try {
      const url = `${API_URL}?${new URLSearchParams({
        action: 'query', format: 'json', generator: 'search', gsrnamespace: '6',
        gsrsearch: `${term} filetype:bitmap`, gsrlimit: '20',
        prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1920'
      })}`;
      const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
      pages = Object.values((await response.json()).query?.pages || {});
    } catch (error) {
      logger?.warn(`Wikimedia search for "${term}" failed: ${error.message}`);
      continue;
    }

    const candidates = pages
      .map(page => ({ page, info: page.imageinfo?.[0] }))
      .filter(({ info }) => info?.thumburl && info.width >= MIN_WIDTH &&
        FREE_LICENSE.test(info.extmetadata?.LicenseShortName?.value || ''))
      .sort((a, b) => (b.info.width >= b.info.height) - (a.info.width >= a.info.height) || a.page.index - b.page.index);
    perTerm.push({ term, candidates });
  }

  // Round-robin: the best image of every term before a second one of any term.
  const chosen = [];
  const seen = new Set();
  for (let round = 0; round < 2 && chosen.length < max; round++) {
    for (const { term, candidates } of perTerm) {
      const next = candidates.find(({ page }) => !seen.has(page.title));
      if (!next || chosen.length >= max) continue;
      const { page, info } = next;
      seen.add(page.title);
      chosen.push({
        term,
        title: page.title.replace(/^File:/, ''),
        url: info.thumburl,
        source: info.descriptionurl,
        author: stripHtml(info.extmetadata?.Artist?.value) || 'desconhecido',
        license: info.extmetadata.LicenseShortName.value
      });
    }
  }

  await fs.mkdir(directory, { recursive: true });
  const images = [];
  for (const [index, image] of chosen.entries()) {
    const extension = path.extname(new URL(image.url).pathname) || path.extname(image.title) || '.jpg';
    const slug = path.basename(image.title, path.extname(image.title)).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
    const filePath = path.join(directory, `${String(index + 1).padStart(2, '0')}_${slug}${extension}`);
    try {
      const response = await fetchImpl(image.url, { headers: { 'User-Agent': USER_AGENT } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
      images.push({ ...image, path: filePath });
    } catch (error) {
      logger?.warn(`Wikimedia download of "${image.title}" failed: ${error.message}`);
    }
  }

  if (images.length) {
    const credits = images.map(image =>
      `${path.basename(image.path)}\n  "${image.title}" por ${image.author}, ${image.license}\n  ${image.source}`);
    await fs.writeFile(path.join(directory, 'CREDITOS.txt'),
      `Imagens do Wikimedia Commons (cole na descrição do vídeo):\n\n${credits.join('\n\n')}\n`);
  }
  return images;
}

module.exports = { findFreeImages };
