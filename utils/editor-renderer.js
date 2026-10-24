// Renders an editor project to MP4 with FFmpeg in three steps:
// one video segment per block, a join with fades, then the audio mix.
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const { runFFmpeg } = require('./ffmpeg');
const { FADE_SECONDS, ZOOM_MAX } = require('./editor-project');

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const VIDEO_CODEC = ['-r', String(FPS), '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p'];
const COVER = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT}`;

// setsar=1 everywhere: zoompan skews the sample aspect ratio and the join refuses mixed SARs.
const FINISH = 'format=yuv420p,setsar=1';

function zoomFilter(zoom, duration) {
  if (zoom === 'none') return FINISH;
  const frames = Math.max(1, Math.round(duration * FPS));
  const step = (ZOOM_MAX - 1).toFixed(2);
  const z = zoom === 'in' ? `min(1+${step}*on/${frames},${ZOOM_MAX})` : `max(${ZOOM_MAX}-${step}*on/${frames},1)`;
  // Upscaling before zoompan avoids the jitter it shows at the output size.
  return `scale=${WIDTH * 2}:${HEIGHT * 2},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS},${FINISH}`;
}

function buildSegmentArgs({ block, asset, duration, isPortrait, outPath }) {
  const t = duration.toFixed(3);
  if (asset.kind === 'video') {
    return ['-y', '-stream_loop', '-1', '-t', t, '-i', asset.path, '-an',
      '-vf', `${COVER},fps=${FPS},${FINISH}`, '-t', t, ...VIDEO_CODEC, outPath];
  }
  const frame = isPortrait
    ? `[0:v]split[a][b];[a]${COVER},boxblur=20[bg];[b]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`
    : `[0:v]${COVER}`;
  return ['-y', '-loop', '1', '-framerate', String(FPS), '-t', t, '-i', asset.path,
    '-filter_complex', `${frame},${zoomFilter(block.zoom, duration)}[v]`, '-map', '[v]', '-t', t, ...VIDEO_CODEC, outPath];
}

// The filter graph goes to scriptPath so 40+ blocks never hit the command-line limit.
function buildJoinArgs({ segments, scriptPath, outPath }) {
  const lines = [];
  let label = '[0:v]';
  let length = segments[0].duration;
  segments.slice(1).forEach((segment, i) => {
    const out = `[j${i + 1}]`;
    if (segment.transition === 'fade') {
      lines.push(`${label}[${i + 1}:v]xfade=transition=fade:duration=${FADE_SECONDS}:offset=${(length - FADE_SECONDS).toFixed(3)}${out}`);
      length += segment.duration - FADE_SECONDS;
    } else {
      lines.push(`${label}[${i + 1}:v]concat=n=2:v=1:a=0${out}`);
      length += segment.duration;
    }
    label = out;
  });
  lines.push(`${label}format=yuv420p[vout]`);
  const args = ['-y', ...segments.flatMap(segment => ['-i', segment.path]),
    '-filter_complex_script', scriptPath, '-map', '[vout]', ...VIDEO_CODEC, outPath];
  return { args, script: lines.join(';\n') };
}

function buildAudioArgs({ videoPath, narrationPath, music, duration, outPath }) {
  const stereo = 'aresample=48000,aformat=channel_layouts=stereo';
  const inputs = ['-i', videoPath, '-i', narrationPath];
  const filters = [`[1:a]${stereo}[nar]`];
  if (music) {
    inputs.push('-i', music.path);
    filters.push(`[2:a]atrim=start=${music.start}:end=${music.end},asetpts=PTS-STARTPTS,volume=${music.volume},apad,atrim=0:${duration.toFixed(3)},${stereo}[mus]`);
    if (music.duck) {
      filters.push('[nar]asplit=2[narmix][sc]', '[mus][sc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[ducked]',
        '[narmix][ducked]amix=inputs=2:duration=first:normalize=0[mix]');
    } else {
      filters.push('[nar][mus]amix=inputs=2:duration=first:normalize=0[mix]');
    }
  } else {
    filters.push('[nar]anull[mix]');
  }
  // loudnorm works at 192 kHz internally; bring the output back to the 48 kHz video standard.
  filters.push('[mix]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]');
  return ['-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', outPath];
}

async function isPortraitImage(file) {
  const { width, height } = await sharp(file).metadata();
  return height > width;
}

async function renderProject({ project, library, outPath, tempDir, onProgress = () => {}, run = runFFmpeg }) {
  const find = id => (id === 'narration' ? library.narration : library.assets.find(asset => asset.id === id));
  const blocks = project.blocks;
  const total = blocks.length;
  const report = (stage, current, percent) => onProgress({ stage, current, total, percent: Math.round(percent) });
  await fs.mkdir(tempDir, { recursive: true });
  try {
    const segments = [];
    for (const [index, block] of blocks.entries()) {
      report('segments', index + 1, (index / total) * 85);
      const asset = find(block.assetId);
      // A block followed by a fade runs 0.5 s longer so the cross-fade keeps the total length.
      const duration = block.duration + (blocks[index + 1]?.transition === 'fade' ? FADE_SECONDS : 0);
      const name = `seg_${String(index + 1).padStart(3, '0')}.mp4`;
      const isPortrait = asset.kind === 'image' ? await isPortraitImage(asset.path) : false;
      await run(buildSegmentArgs({ block, asset, duration, isPortrait, outPath: name }), { cwd: tempDir });
      segments.push({ path: name, duration, transition: block.transition });
    }

    report('finalizing', total, 88);
    const join = buildJoinArgs({ segments, scriptPath: 'join.txt', outPath: 'joined.mp4' });
    await fs.writeFile(path.join(tempDir, 'join.txt'), join.script);
    await run(join.args, { cwd: tempDir });

    report('finalizing', total, 95);
    const music = project.music ? { ...project.music, path: find(project.music.assetId).path } : null;
    const duration = blocks.reduce((sum, block) => sum + block.duration, 0);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await run(buildAudioArgs({ videoPath: path.join(tempDir, 'joined.mp4'), narrationPath: library.narration.path, music, duration, outPath }));
    report('finalizing', total, 100);
    return outPath;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = { buildSegmentArgs, buildJoinArgs, buildAudioArgs, renderProject };
