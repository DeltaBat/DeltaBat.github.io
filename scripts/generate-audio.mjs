#!/usr/bin/env node
/**
 * Pre-generate per-chapter MP3s for the audiobook player.
 *
 * Reads index.html, walks every <script id="..-chapter-N" type="text/plain"> block,
 * mirrors the same chunking + TTS logic the in-browser player uses, and writes
 * each chapter as audio/<scriptId>-<voice>.mp3.
 *
 * Skips chapters that already have audio on disk so re-runs are cheap.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

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

function buildTTSText(blocks) {
  const lines = [];
  for (const b of blocks) {
    if (b.kind === 'p') lines.push(b.text);
    else {
      let t = b.text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      lines.push('The ledger reads. ' + t);
    }
  }
  return lines.join('\n\n');
}

function chunkForTTS(text) {
  const sentences = splitSentences(text);
  const chunks = []; let cur = '';
  const enc = new TextEncoder();
  const flush = () => { if (cur.trim()) { chunks.push(cur.trim()); cur = ''; } };
  for (const s of sentences) {
    const tentative = cur ? (cur + ' ' + s) : s;
    if (enc.encode(tentative).length > MAX_CHUNK_BYTES) {
      flush();
      if (enc.encode(s).length > MAX_CHUNK_BYTES) {
        const words = s.split(' '); let w = '';
        for (const word of words) {
          const t2 = w ? (w + ' ' + word) : word;
          if (enc.encode(t2).length > MAX_CHUNK_BYTES) { if (w) chunks.push(w); w = word; }
          else w = t2;
        }
        if (w) chunks.push(w);
      } else cur = s;
    } else cur = tentative;
  }
  flush();
  return chunks;
}

async function tts(chunkText, voice) {
  const lang = voice.startsWith('en-GB') ? 'en-GB' : 'en-US';
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(apiKey), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { text: chunkText },
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
  const outMp3 = `audio/${id}-${voice}.mp3`;
  if (existsSync(outMp3)) {
    console.log(`  skip ${id} (already exists)`);
    continue;
  }
  let txt = rawBody.trim();
  const tm = txt.match(/^TITLE:[^\n]+\n/);
  if (tm) txt = txt.slice(tm[0].length).trim();
  const blocks = parseBlocks(txt);
  const ttsText = buildTTSText(blocks);
  const chunks = chunkForTTS(ttsText);
  console.log(`  ${id}: ${chunks.length} chunks, ${ttsText.length} chars`);
  const audios = [];
  for (let i = 0; i < chunks.length; i++) {
    const bytes = await tts(chunks[i], voice);
    audios.push(bytes);
    console.log(`    chunk ${i + 1}/${chunks.length} (${bytes.length} B)`);
  }
  const all = Buffer.concat(audios);
  writeFileSync(outMp3, all);
  console.log(`  wrote ${outMp3} (${all.length} bytes)`);
  processed++;
}

console.log(`Done. Processed ${processed} chapter(s).`);
