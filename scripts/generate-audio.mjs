#!/usr/bin/env node
/**
 * Pre-generate per-chapter MP3s + sentence-level timing JSON.
 *
 * For each <script id="..-chapter-N" type="text/plain"> block in index.html:
 *   1. Walks blocks and sentences the same way the in-browser player does.
 *   2. Groups sentences into TTS chunks (≤ MAX_CHUNK_BYTES UTF-8).
 *   3. Calls Google TTS once per chunk and measures the returned MP3's
 *      duration with ffprobe.
 *   4. Distributes each chunk's duration across its sentences by character
 *      weight, producing per-sentence start times.
 *   5. Writes audio/<scriptId>-<voice>.mp3 and audio/<scriptId>-<voice>.json.
 *
 * Skips chapters where both files already exist. Regenerates if the MP3 is
 * present but the sidecar JSON is missing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_VOICE = process.env.TTS_VOICE || 'en-US-Chirp3-HD-Fenrir';
const MAX_CHUNK_BYTES = 4500;
const apiKey = process.env.GOOGLE_TTS_API_KEY;
if (!apiKey) {
  console.error('Missing GOOGLE_TTS_API_KEY env var. Set it as a repo secret.');
  process.exit(1);
}

const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|St|Sr|Jr|vs|etc|e\.g|i\.e|Mt|No|Vol|Ch)\.$/i;

function splitSentences(text) {
  const out = []; let buf = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]; buf += c;
    if (c === '.' || c === '!' || c === '?') {
      while (i + 1 < chars.length && /["'’”\)\]\}\.!\?…—–-]/.test(chars[i + 1])) {
        buf += chars[i + 1]; i++;
      }
      const nxt = chars[i + 1];
      if ((nxt === undefined || /\s/.test(nxt)) && !ABBREV.test(buf.trim())) {
        out.push(buf.trim()); buf = '';
        while (i + 1 < chars.length && /\s/.test(chars[i + 1])) i++;
      }
    }
  }
  const tail = buf.trim(); if (tail) out.push(tail);
  return out;
}

function parseBlocks(body) {
  const blocks = []; const parts = body.split(/\n{2,}/);
  let inLedger = false; let buf = [];
  for (const p of parts) {
    const t = p.trim(); if (!t) continue;
    if (!inLedger) {
      if (t.startsWith('[LEDGER]')) {
        inLedger = true;
        const rest = t.replace(/^\[LEDGER\]\s*/, '');
        if (rest.includes('[/LEDGER]')) {
          const inner = rest.replace(/\s*\[\/LEDGER\]\s*$/, '');
          blocks.push({ kind: 'ledger', text: inner });
          inLedger = false;
        } else { buf = [rest]; }
      } else blocks.push({ kind: 'p', text: t });
    } else {
      if (t.includes('[/LEDGER]')) {
        const last = t.replace(/\s*\[\/LEDGER\]\s*$/, '');
        if (last) buf.push(last);
        blocks.push({ kind: 'ledger', text: buf.join('\n\n') });
        inLedger = false; buf = [];
      } else buf.push(t);
    }
  }
  return blocks;
}

// Walks blocks in document order and emits one "sentence" per .s element the
// player creates. Paragraphs are split into per-sentence elements; ledger
// blocks become a single element prefixed with "The ledger reads. ".
function buildSentences(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.kind === 'p') {
      for (const s of splitSentences(b.text)) out.push(s);
    } else {
      const t = b.text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      out.push('The ledger reads. ' + t);
    }
  }
  return out;
}

function chunkSentences(sentences) {
  const enc = new TextEncoder();
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const sBytes = enc.encode(s).length + 1;
    if (curBytes + sBytes > MAX_CHUNK_BYTES && cur.length > 0) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push({ idx: i, text: s });
    curBytes += sBytes;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function tts(text, voice) {
  const lang = voice.startsWith('en-GB') ? 'en-GB' : 'en-US';
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(apiKey), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: lang, name: voice },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`TTS API ${r.status}: ${t.slice(0, 400)}`);
  }
  const j = await r.json();
  return Buffer.from(j.audioContent, 'base64');
}

function probeDuration(filePath) {
  const out = execFileSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', filePath,
  ]).toString().trim();
  const d = parseFloat(out);
  if (!isFinite(d)) throw new Error('ffprobe returned non-numeric duration: ' + out);
  return d;
}

async function generateChapter(scriptId, rawBody, voice) {
  let txt = rawBody.trim();
  const tm = txt.match(/^TITLE:[^\n]+\n/);
  if (tm) txt = txt.slice(tm[0].length).trim();
  const blocks = parseBlocks(txt);
  const sentences = buildSentences(blocks);
  const chunks = chunkSentences(sentences);

  console.log(`  ${scriptId}: ${sentences.length} sentences, ${chunks.length} chunk(s)`);

  const allAudio = [];
  const timings = [];
  let cumulativeTime = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunkSents = chunks[ci];
    const chunkText = chunkSents.map(s => s.text).join(' ');
    const bytes = await tts(chunkText, voice);
    allAudio.push(bytes);

    const tmpPath = join(tmpdir(), `chunk-${scriptId}-${ci}.mp3`);
    writeFileSync(tmpPath, bytes);
    let duration;
    try {
      duration = probeDuration(tmpPath);
    } catch (e) {
      console.warn(`    ffprobe failed for chunk ${ci}: ${e.message}`);
      duration = chunkText.length / 15;
    }

    const totalChars = chunkSents.reduce((sum, s) => sum + s.text.length, 0);
    let chunkOffset = 0;
    for (const s of chunkSents) {
      timings.push({ idx: s.idx, startTime: +(cumulativeTime + chunkOffset).toFixed(3) });
      const weight = s.text.length / totalChars;
      chunkOffset += duration * weight;
    }

    cumulativeTime += duration;
    process.stdout.write(`    chunk ${ci + 1}/${chunks.length} (${bytes.length} B, ${duration.toFixed(2)}s)\n`);
  }

  const combined = Buffer.concat(allAudio);
  const mp3Path = `audio/${scriptId}-${voice}.mp3`;
  const jsonPath = `audio/${scriptId}-${voice}.json`;
  writeFileSync(mp3Path, combined);
  writeFileSync(jsonPath, JSON.stringify({
    scriptId,
    voice,
    totalDuration: +cumulativeTime.toFixed(3),
    sentenceCount: sentences.length,
    sentences: timings,
  }, null, 2));
  console.log(`  wrote ${mp3Path} (${combined.length} B) + sidecar`);
}

const html = readFileSync('index.html', 'utf8');
mkdirSync('audio', { recursive: true });
const re = /<script id="((?:wyrm-)?chapter-\d+)" type="text\/plain">\n([\s\S]*?)\n<\/script>/g;
const voice = DEFAULT_VOICE;
const found = [];
let m;
while ((m = re.exec(html))) found.push({ id: m[1], rawBody: m[2] });
console.log(`Found ${found.length} chapter block(s). Voice: ${voice}`);

let processed = 0;
for (const { id, rawBody } of found) {
  const mp3 = `audio/${id}-${voice}.mp3`;
  const json = `audio/${id}-${voice}.json`;
  if (existsSync(mp3) && existsSync(json)) {
    console.log(`  skip ${id} (mp3 + json exist)`);
    continue;
  }
  if (existsSync(mp3) && !existsSync(json)) {
    console.log(`  ${id}: regenerating (mp3 exists but sidecar missing)`);
  }
  await generateChapter(id, rawBody, voice);
  processed++;
}
console.log(`Done. Processed ${processed} chapter(s).`);
