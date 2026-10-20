const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: os.tmpdir() });

// Health check
app.get('/', (req, res) => {
  res.send('3DFacts Visualizer Studio — Cloud Render Server is Online');
});

// Cloud Render Endpoint
app.post('/api/render', upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'logo', maxCount: 1 },
  { name: 'bg', maxCount: 1 }
]), async (req, res) => {
  const reqId = Date.now() + '_' + Math.random().toString(36).substring(7);
  const tempFiles = [];

  try {
    if (!req.files || !req.files.audio) {
      return res.status(400).json({ error: 'Audio file is required.' });
    }

    const audioPath = req.files.audio[0].path;
    tempFiles.push(audioPath);

    let logoImg = null;
    if (req.files.logo) {
      tempFiles.push(req.files.logo[0].path);
      logoImg = await loadImage(req.files.logo[0].path);
    }

    let bgImg = null;
    if (req.files.bg) {
      tempFiles.push(req.files.bg[0].path);
      bgImg = await loadImage(req.files.bg[0].path);
    }

    const config = JSON.parse(req.body.config || '{}');
    const width = config.resolution === '1080p' ? 1920 : 1280;
    const height = config.resolution === '1080p' ? 1080 : 720;
    const fps = parseInt(config.fps, 10) || 24;

    // 1. Probe audio duration using ffprobe
    const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
    const audioDuration = parseFloat(execSync(durationCmd).toString().trim());

    if (!audioDuration || isNaN(audioDuration)) {
      throw new Error('Unable to probe audio duration.');
    }

    const totalFrames = Math.ceil(audioDuration * fps);

    // 2. Decode Audio into Raw 32-bit Float PCM via FFmpeg
    const pcmPath = path.join(os.tmpdir(), `pcm_${reqId}.raw`);
    tempFiles.push(pcmPath);
    execSync(`ffmpeg -y -v error -i "${audioPath}" -f f32le -ac 1 -ar 44100 "${pcmPath}"`);
    const pcmBuffer = fs.readFileSync(pcmPath);
    const pcmSamples = new Float32Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 4);

    // 3. Setup Video Output Stream
    const outputPath = path.join(os.tmpdir(), `render_${reqId}.mp4`);
    tempFiles.push(outputPath);

    const ffmpegArgs = [
      '-y',
      '-f', 'rawvideo',
      '-vcodec', 'rawvideo',
      '-s', `${width}x${height}`,
      '-pix_fmt', 'rgba',
      '-r', `${fps}`,
      '-i', '-',
      '-i', audioPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      outputPath
    ];

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    ffmpegProcess.stderr.on('data', (d) => {
      // Internal ffmpeg logging
    });

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Pre-allocated static FFT arrays
    const FFT_SIZE = 1024;
    const real = new Float32Array(FFT_SIZE);
    const imag = new Float32Array(FFT_SIZE);
    const mags = new Float32Array(FFT_SIZE / 2);
    const bins = new Float32Array(64);
    const hann = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));

    // Radial particles state
    const particles = [];
    for (let i = 0; i < 90; i++) {
      particles.push({
        angle: Math.random() * Math.PI * 2,
        speed: 0.2 + Math.random() * 0.6,
        size: 1.5 + Math.random() * 2.8,
        colorIdx: Math.random() > 0.5 ? 1 : 2
      });
    }

    let bassEnvelope = 0;

    // 4. Render frames & pipe directly to FFmpeg stdin
    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      const timestampSec = frameIdx / fps;
      const centerSample = Math.floor(timestampSec * 44100);
      const halfWindow = FFT_SIZE / 2;
      const start = centerSample - halfWindow;

      for (let i = 0; i < FFT_SIZE; i++) {
        const idx = start + i;
        const s = (idx >= 0 && idx < pcmSamples.length) ? pcmSamples[idx] : 0;
        real[i] = s * hann[i];
        imag[i] = 0;
      }

      runInPlaceFFT(real, imag, FFT_SIZE);

      const halfN = FFT_SIZE / 2;
      for (let i = 0; i < halfN; i++) mags[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / halfN;

      const binHz = 44100 / FFT_SIZE;
      const bassStart = Math.max(1, Math.floor(30 / binHz));
      const bassEnd = Math.min(halfN - 1, Math.ceil(150 / binHz));
      let rawBass = 0;
      for (let i = bassStart; i <= bassEnd; i++) rawBass += mags[i];
      const instantBass = Math.min(1.5, (rawBass / (bassEnd - bassStart + 1)) * 5.0);

      if (instantBass > bassEnvelope) bassEnvelope = instantBass;
      else bassEnvelope *= 0.86;

      const logMin = Math.log10(30);
      const logMax = Math.log10(16000);
      for (let b = 0; b < 64; b++) {
        const fStart = Math.pow(10, logMin + (b / 64) * (logMax - logMin));
        const fEnd = Math.pow(10, logMin + ((b + 1) / 64) * (logMax - logMin));
        const bIdxStart = Math.max(0, Math.min(halfN - 1, Math.floor(fStart / binHz)));
        const bIdxEnd = Math.max(bIdxStart + 1, Math.min(halfN, Math.ceil(fEnd / binHz)));
        let sum = 0;
        let cnt = 0;
        for (let k = bIdxStart; k < bIdxEnd; k++) { sum += mags[k]; cnt++; }
        bins[b] = Math.min(1.0, Math.pow((cnt > 0 ? sum / cnt : 0) * 6.5, 0.78));
      }

      // Draw Scene
      renderScene(ctx, width, height, timestampSec, bins, bassEnvelope, config, bgImg, logoImg, particles);

      // Write frame to ffmpeg stdin with backpressure guard
      const rawFrame = canvas.toBuffer('raw');
      if (!ffmpegProcess.stdin.write(rawFrame)) {
        await new Promise((resolve) => ffmpegProcess.stdin.once('drain', resolve));
      }
    }

    ffmpegProcess.stdin.end();

    await new Promise((resolve, reject) => {
      ffmpegProcess.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}`));
      });
      ffmpegProcess.on('error', reject);
    });

    // 5. Send Completed MP4 Video
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${config.title || '3dfacts-visualizer'}.mp4"`);

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on('close', cleanup);
  } catch (err) {
    console.error('Render error:', err);
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Server render failed' });
    }
  }

  function cleanup() {
    tempFiles.forEach((file) => {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {}
    });
  }
});

function runInPlaceFFT(real, imag, n) {
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
    let k = n >> 1;
    while (k <= j) { j -= k; k >>= 1; }
    j += k;
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = -2 * Math.PI / len;
    const wStepR = Math.cos(angle);
    const wStepI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1.0;
      let wi = 0.0;
      for (let k = 0; k < half; k++) {
        const uR = real[i + k];
        const uI = imag[i + k];
        const vR = real[i + k + half] * wr - imag[i + k + half] * wi;
        const vI = real[i + k + half] * wi + imag[i + k + half] * wr;
        real[i + k] = uR + vR;
        imag[i + k] = uI + vI;
        real[i + k + half] = uR - vR;
        imag[i + k + half] = uI - vI;
        const nextWr = wr * wStepR - wi * wStepI;
        wi = wr * wStepI + wi * wStepR;
        wr = nextWr;
      }
    }
  }
}

function renderScene(ctx, w, h, time, bins, bass, cfg, bgImg, logoImg, particles) {
  ctx.save();
  ctx.clearRect(0, 0, w, h);

  const c1 = cfg.primaryColor || '#8b5cf6';
  const c2 = cfg.secondaryColor || '#06b6d4';
  const cAccent = cfg.accentColor || '#ec4899';
  const cBg = cfg.bgColor || '#07090e';
  const sens = (cfg.sensitivity || 16) * 0.1;
  const bassReact = bass * sens;

  const cx = w / 2;
  const cy = h / 2 + (cfg.visualizerY || 0);
  const ringR = (cfg.spectrumSize || 190) * (h / 720);

  // 1. Boom Baap Zoom
  const boomScale = 1.0 + (bassReact * 0.08);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(boomScale, boomScale);
  ctx.translate(-cx, -cy);

  // Background
  if (bgImg) {
    const scale = Math.max(w / bgImg.width, h / bgImg.height);
    const nw = bgImg.width * scale;
    const nh = bgImg.height * scale;
    ctx.drawImage(bgImg, (w - nw) / 2, (h - nh) / 2, nw, nh);
    ctx.fillStyle = 'rgba(7, 9, 14, 0.72)';
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = cBg;
    ctx.fillRect(0, 0, w, h);
  }

  // Shockwave
  if (bassReact > 0.3) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, ringR + (bassReact * 75), 0, Math.PI * 2);
    ctx.strokeStyle = c1;
    ctx.lineWidth = 3;
    ctx.globalAlpha = Math.max(0, (bassReact - 0.2) * 0.6);
    ctx.stroke();
    ctx.restore();
  }

  // Specterr Radial Outward Particles
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  const blast = bassReact > 0.3;
  ctx.save();
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    let advance = (time * p.speed * 0.25) % 1.0;
    if (blast) advance = (advance + bassReact * 0.08) % 1.0;
    const curR = ringR + advance * (maxDist - ringR);
    const x = cx + Math.cos(p.angle) * curR;
    const y = cy + Math.sin(p.angle) * curR;
    const alpha = (1 - curR / maxDist) * Math.min(1, (curR - ringR) / 40);

    ctx.beginPath();
    ctx.arc(x, y, p.size * (h / 720), 0, Math.PI * 2);
    ctx.fillStyle = p.colorIdx === 1 ? c1 : c2;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fill();
  }
  ctx.restore();

  // Circular Spectrum Bars
  const count = 64;
  const angleStep = (Math.PI * 2) / count;
  for (let i = 0; i < count; i++) {
    const barH = Math.max(4, bins[i] * sens * (ringR * 0.9));
    const angle = i * angleStep - Math.PI / 2;
    const x1 = cx + Math.cos(angle) * ringR;
    const y1 = cy + Math.sin(angle) * ringR;
    const x2 = cx + Math.cos(angle) * (ringR + barH);
    const y2 = cy + Math.sin(angle) * (ringR + barH);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = i % 2 === 0 ? c1 : c2;
    ctx.lineWidth = Math.max(2, (cfg.barThickness || 5) * (w / 1280));
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Center Logo
  const baseLogoR = ((cfg.logoSize || 160) / 2) * (h / 720);
  const logoPunch = 1.0 + (bassReact * 0.22);
  const reactiveR = baseLogoR * logoPunch;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.arc(0, 0, reactiveR, 0, Math.PI * 2);
  ctx.clip();
  if (logoImg) {
    ctx.drawImage(logoImg, -reactiveR, -reactiveR, reactiveR * 2, reactiveR * 2);
  } else {
    ctx.fillStyle = c1;
    ctx.fillRect(-reactiveR, -reactiveR, reactiveR * 2, reactiveR * 2);
  }
  ctx.restore();

  // Track Title
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(28 * (h / 720))}px sans-serif`;
  ctx.fillText(cfg.title || 'Neon Horizon', cx, h * 0.86);

  ctx.fillStyle = c2;
  ctx.font = `600 ${Math.round(18 * (h / 720))}px sans-serif`;
  ctx.fillText(cfg.creator || 'Diplap Music', cx, h * 0.86 + 26);
  ctx.restore();

  ctx.restore(); // Close Boom

  // Watermark: 3dfacts.site.je
  const pad = Math.round(24 * (w / 1280));
  ctx.save();
  ctx.font = `600 ${Math.round(14 * (h / 720))}px monospace`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText('3dfacts.site.je', w - pad, pad);
  ctx.restore();

  ctx.restore();
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
