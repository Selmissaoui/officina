// Records one window to a video file (dev tool for the demo video).
// Run: npx electron tools/demo/recorder.js --port=9555
// Control over HTTP: POST /start?title=Officina&out=<file>&w=1920&h=1080, POST /stop.
// The window's title bar is cropped off: the video shows only its content area.
const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const http = require('http');
const fs = require('fs');

const PORT = Number((process.argv.find(a => a.startsWith('--port=')) || '--port=9555').slice(7));
let win, out = null, stopped = null;

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<video id="v" muted playsinline style="display:none"></video><canvas id="c"></canvas>
<script>
const { ipcRenderer } = require('electron');
let rec, timer, stream;
ipcRenderer.on('start', async (_e, { sourceId, w, h, fps }) => { try {
  stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, minFrameRate: fps, maxFrameRate: fps, maxWidth: 4096, maxHeight: 4096 } } });
  const v = document.getElementById('v'), c = document.getElementById('c');
  v.srcObject = stream; await v.play();
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  // The content sits at the bottom of the captured window, below the title bar.
  const draw = () => { const vw = v.videoWidth, vh = v.videoHeight; if (!vw) return; const side = Math.max(0, Math.round((vw - w) / 2)); g.drawImage(v, side, Math.max(0, vh - h - side), w, h, 0, 0, w, h); };
  timer = setInterval(draw, 1000 / fps);
  const types = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d0028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mimeType = types.find(t => MediaRecorder.isTypeSupported(t));
  rec = new MediaRecorder(c.captureStream(fps), { mimeType, videoBitsPerSecond: 14e6 });
  rec.ondataavailable = async e => { if (e.data.size) ipcRenderer.send('chunk', new Uint8Array(await e.data.arrayBuffer())); };
  rec.onstop = () => { clearInterval(timer); stream.getTracks().forEach(t => t.stop()); setTimeout(() => ipcRenderer.send('done'), 300); };
  rec.start(1000);
  ipcRenderer.send('started', mimeType);
  } catch (e) { ipcRenderer.send('started', 'ERROR ' + (e && (e.name + ': ' + e.message))); } 
});
ipcRenderer.on('stop', () => rec && rec.state !== 'inactive' && rec.stop());
</script></body></html>`;

app.whenReady().then(() => {
  win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  // A file page, not a data: URL: screen capture needs a secure context.
  const page = require('path').join(require('os').tmpdir(), 'officina-recorder.html');
  fs.writeFileSync(page, PAGE);
  win.loadFile(page);
  ipcMain.on('chunk', (_e, data) => out?.write(Buffer.from(data)));
  ipcMain.on('done', () => { out?.end(() => { out = null; stopped?.(); }); });
  let started = null;
  ipcMain.on('started', (_e, mime) => started?.(mime));

  http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/start') {
        const title = u.searchParams.get('title') || 'Officina';
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
        const src = sources.find(s => s.name === title) || sources.find(s => s.name.includes(title));
        if (!src) throw new Error(`no window called ${title}: ${sources.map(s => s.name).join(' | ')}`);
        out = fs.createWriteStream(u.searchParams.get('out'));
        const mime = await new Promise(r => { started = r; win.webContents.send('start', { sourceId: src.id, w: Number(u.searchParams.get('w') || 1920), h: Number(u.searchParams.get('h') || 1080), fps: Number(u.searchParams.get('fps') || 30) }); });
        if (String(mime).startsWith('ERROR')) throw new Error(mime);
        res.end(JSON.stringify({ ok: true, mime, window: src.name }));
      } else if (u.pathname === '/stop') {
        await new Promise(r => { stopped = r; win.webContents.send('stop'); });
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => app.quit(), 200);
      } else { res.statusCode = 404; res.end(); }
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
  }).listen(PORT, '127.0.0.1', () => console.log(`recorder on ${PORT}`));
});
