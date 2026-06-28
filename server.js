/**
 * FreeToTranscribe — media-resolver microservice (hybrid).
 *
 * Two paths, one service:
 *   • YouTube           → fetch the video's EXISTING captions (yt-dlp --write-auto-subs,
 *                         no media download, no transcription) and return them as SRT.
 *                         Reliable from a server; YouTube media download is NOT (2026
 *                         datacenter-IP blocking) so we deliberately avoid it.
 *   • TikTok/Instagram  → download bestaudio, transcode to small mono m4a, and PUT it to
 *                         a presigned R2 URL so the existing transcribe pipeline runs.
 *
 * The FTT Worker (/api/resolve-url) is the only caller; it sends a shared secret.
 *
 * Env:
 *   RESOLVER_SECRET   shared secret; requests must send it as X-FTT-Secret
 *   PORT              listen port (default 8080)
 *   YTDLP_BIN / FFMPEG_BIN / FFPROBE_BIN   binary paths (default: on PATH)
 */

import express from 'express';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT            = parseInt(process.env.PORT || '8080', 10);
const RESOLVER_SECRET = process.env.RESOLVER_SECRET || '';
const YTDLP_BIN       = process.env.YTDLP_BIN   || 'yt-dlp';
const FFMPEG_BIN      = process.env.FFMPEG_BIN  || 'ffmpeg';
const FFPROBE_BIN     = process.env.FFPROBE_BIN || 'ffprobe';

const MAX_BYTES       = 25 * 1024 * 1024;   // matches the existing 25MB pipeline cap
const MAX_SECONDS     = 3600;               // 60 min cap (matches free daily limit)
const JOB_TIMEOUT_MS  = 90 * 1000;          // hard wall on a single resolve

const AUDIO_HOST_RE   = /^(www\.|vm\.|vt\.|m\.)?(tiktok\.com|instagram\.com)$/i;
const YOUTUBE_HOST_RE = /(^|\.)(youtube\.com|youtu\.be)$/i;

function platformOf(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (YOUTUBE_HOST_RE.test(host)) return 'youtube';
  if (AUDIO_HOST_RE.test(host))   return 'audio';
  return null;
}
function isR2Url(url) {
  try { return new URL(url).hostname.endsWith('.r2.cloudflarestorage.com'); }
  catch { return false; }
}

// Spawn, discard stdout, capture stderr, kill on timeout.
function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
    p.stderr.on('data', d => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    p.on('error', err => { clearTimeout(timer); reject(err); });
    p.on('close', code => code === 0 ? resolve()
      : reject(new Error(`${bin} exited ${code}: ${stderr.slice(-600)}`)));
  });
}

// Spawn and capture stdout (for --print metadata / ffprobe).
function runCapture(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve(''); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(''); });
    p.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
  });
}

// Precise sub-language list (NO wildcards — wildcards expand to dozens of
// auto-translations and trip YouTube's 429 rate limit).
function subLangs(lang) {
  const l = (lang || '').toLowerCase();
  if (!l || l === 'auto' || l === 'en') return 'en,en-orig';
  return `${l},en`; // requested language, English fallback
}

async function resolveYouTubeCaptions(url, lang, dir) {
  // Fetch captions + metadata only — no media download, no JS runtime needed.
  await run(YTDLP_BIN, [
    '--no-playlist', '--no-warnings', '--no-progress', '--skip-download',
    '--write-subs', '--write-auto-subs', '--write-info-json',
    '--sub-langs', subLangs(lang), '--sub-format', 'srt/best', '--convert-subs', 'srt',
    '-o', join(dir, 'cap.%(ext)s'),
    url,
  ], JOB_TIMEOUT_MS);

  const all   = await readdir(dir);
  const files = all.filter(f => f.endsWith('.srt'));
  if (!files.length) { const e = new Error('no_captions'); e.code = 'no_captions'; throw e; }
  // Prefer a file matching the requested language, else the first.
  const want = (lang || '').toLowerCase();
  const pick = (want && files.find(f => f.toLowerCase().includes(`.${want}`))) || files[0];
  const transcript = await readFile(join(dir, pick), 'utf8');

  let durationSeconds = 0;
  const infoFile = all.find(f => f.endsWith('.info.json'));
  if (infoFile) {
    try { durationSeconds = Math.round(JSON.parse(await readFile(join(dir, infoFile), 'utf8')).duration || 0); }
    catch {}
  }
  return { transcript, durationSeconds };
}

async function resolveAudio(url, uploadUrl, dir) {
  const outM4a = join(dir, 'audio.m4a');
  await run(YTDLP_BIN, [
    '--no-playlist', '--no-warnings', '--no-progress',
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'm4a',
    '--postprocessor-args', `FFmpegExtractAudio:-ac 1 -b:a 48k -t ${MAX_SECONDS}`,
    '-o', join(dir, 'audio.%(ext)s'),
    url,
  ], JOB_TIMEOUT_MS);

  const { size } = await stat(outM4a);
  if (size > MAX_BYTES) { const e = new Error('too_large'); e.code = 'too_large'; throw e; }

  const durStr = await runCapture(FFPROBE_BIN,
    ['-v', 'quiet', '-show_entries', 'format=duration', '-of',
     'default=noprint_wrappers=1:nokey=1', outM4a], 15000);
  const durationSeconds = Math.round(parseFloat(durStr) || 0);

  const buf = await readFile(outM4a);
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/mp4', 'Content-Length': String(buf.length) },
    body: buf,
  });
  if (!put.ok) { const e = new Error('upload_failed'); e.code = 'upload_failed'; throw e; }
  return { durationSeconds, sizeMB: +(size / 1048576).toFixed(2) };
}

const app = express();
app.use(express.json({ limit: '16kb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/resolve', async (req, res) => {
  if (!RESOLVER_SECRET || req.get('X-FTT-Secret') !== RESOLVER_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { url, uploadUrl, lang } = req.body || {};
  if (typeof url !== 'string') return res.status(400).json({ error: 'bad_request' });

  const platform = platformOf(url);
  if (!platform) return res.status(422).json({ error: 'unsupported_platform' });

  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'ftt-'));

    if (platform === 'youtube') {
      const { transcript, durationSeconds } = await resolveYouTubeCaptions(url, lang, dir);
      return res.json({ ok: true, kind: 'transcript', transcript, durationSeconds });
    }

    // audio path (TikTok/Instagram) requires a valid R2 upload target
    if (!isR2Url(uploadUrl)) return res.status(400).json({ error: 'bad_upload_target' });
    const { durationSeconds, sizeMB } = await resolveAudio(url, uploadUrl, dir);
    return res.json({ ok: true, kind: 'audio', durationSeconds, sizeMB });
  } catch (e) {
    const code = e.code || '';
    const msg  = String(e.message || e);
    if (code === 'no_captions')  return res.status(422).json({ error: 'no_captions' });
    if (code === 'too_large')    return res.status(413).json({ error: 'too_large' });
    if (code === 'upload_failed')return res.status(502).json({ error: 'upload_failed' });
    if (msg === 'timeout')       return res.status(504).json({ error: 'resolve_timeout', detail: 'timeout' });
    if (/private|login|unavailable|not available|removed|sign in|404/i.test(msg)) {
      return res.status(422).json({ error: 'unavailable', detail: msg.slice(0, 400) });
    }
    console.error('[resolve] failed:', msg);
    return res.status(502).json({ error: 'resolve_failed', detail: msg.slice(0, 400) });
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => console.log(`media-resolver listening on :${PORT}`));
