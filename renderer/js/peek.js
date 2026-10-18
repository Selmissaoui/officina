// Peek: a screenshot or a short clip of what an agent is doing. Frames come from the main
// process (the agent's browser page, or the canvas); a clip is recorded here with MediaRecorder.
import { h, modal, toast } from './ui.js';

const FPS = 5;
const toBitmap = bytes => createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));

export async function recordClip(itemId, seconds) {
  const first = await toBitmap(await window.ac.peekFrame(itemId));
  const canvas = document.createElement('canvas');
  canvas.width = first.width & ~1;
  canvas.height = first.height & ~1;
  const g = canvas.getContext('2d');
  g.drawImage(first, 0, 0, canvas.width, canvas.height);
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(canvas.captureStream(FPS), { mimeType: mime, videoBitsPerSecond: 2500000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  // A capture can take a second or more; the clip still gets a steady FPS by drawing the
  // latest picture on a fixed beat, separately from fetching new ones.
  let latest = first;
  const beat = setInterval(() => g.drawImage(latest, 0, 0, canvas.width, canvas.height), 1000 / FPS);
  rec.start(1000);
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const t = Date.now();
    try {
      const bmp = await toBitmap(await window.ac.peekFrame(itemId));
      if (latest !== bmp) latest.close();
      latest = bmp;
    } catch { /* keep the last picture */ }
    await new Promise(r => setTimeout(r, Math.max(0, 1000 / FPS - (Date.now() - t))));
  }
  clearInterval(beat);
  g.drawImage(latest, 0, 0, canvas.width, canvas.height);
  latest.close();
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  return { blob, mime: blob.type };
}

// Requests from Telegram/Discord: record and hand the bytes back to the main process.
export function listenForPeek() {
  window.ac.on('peek:record', async (id, itemId, seconds) => {
    try {
      const { blob, mime } = await recordClip(itemId, seconds);
      await window.ac.peekRecorded(id, new Uint8Array(await blob.arrayBuffer()), mime);
    } catch (e) { window.ac.peekRecorded(id, null, null, e.message || 'Recording failed'); }
  });
}

// The Peek button on an agent card.
export async function peekDialog(agentName) {
  const target = await window.ac.peekTarget(agentName);
  const stage = h('div', { class: 'peek-stage' }, h('p', { class: 'muted' }, 'Taking a picture…'));
  const show = el => { stage.replaceChildren(el); };
  const takeShot = async () => {
    try { show(h('img', { src: URL.createObjectURL(new Blob([await window.ac.peekFrame(target?.id)], { type: 'image/jpeg' })), alt: `What ${agentName} sees` })); }
    catch (e) { show(h('p', { class: 'muted' }, String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))); }
  };
  const record = async secs => {
    show(h('p', { class: 'muted' }, `Recording ${secs} seconds…`));
    try {
      const { blob, mime } = await recordClip(target?.id, secs);
      const url = URL.createObjectURL(blob);
      show(h('div', {}, h('video', { src: url, controls: true, autoplay: true, muted: true, loop: true }),
        h('a', { class: 'btn small', href: url, download: `peek-${agentName}.${mime.includes('mp4') ? 'mp4' : 'webm'}` }, 'Save clip')));
    } catch (e) { toast(e.message, 'warn'); takeShot(); }
  };
  const head = h('p', { class: 'muted' }, target ? `${agentName} last worked in "${target.title}".` : `${agentName} has no window yet: this is the canvas.`);
  takeShot();
  await modal({
    title: `Peek: ${agentName}`, wide: true,
    body: h('div', { class: 'peek' }, head, stage,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn small', onclick: takeShot }, 'New picture'),
        h('button', { class: 'btn small', onclick: () => record(5) }, 'Record 5 s'),
        h('button', { class: 'btn small', onclick: () => record(15) }, 'Record 15 s'))),
    actions: [{ label: 'Close', value: true }],
  });
}
