'use strict';
const fs = require('fs');
const path = require('path');
const { appendJsonl, readJsonl, newId } = require('./store');
class Replay {
  constructor({ ws, browsers }) { Object.assign(this, { ws, browsers }); this.file = path.join(ws.root, 'replay.jsonl'); }
  async record(name, args, result) {
    const entry = { id: newId('step'), time: new Date().toISOString(), name, itemId: args.id, ok: !result.isError };
    // Never retain typed values, credentials, or full tool arguments.
    if (this.ws.settings.replayScreenshots && args.id && this.ws.getItem(args.id)?.type === 'browser' && name !== 'ask_user') {
      try {
        const wc = this.browsers.wc(args.id);
        const sensitive = await wc.executeJavaScript("!!document.querySelector('input[type=password]')");
        if (!sensitive) {
          const image = await Promise.race([wc.capturePage(), new Promise(resolve => setTimeout(() => resolve(null), 1500))]);
          if (image && !image.isEmpty()) entry.screenshot = this.ws.writeFile('replay/' + entry.id + '.png', image.toPNG(), 'system');
        }
      } catch { /* an audit entry still records the completed action */ }
    }
    appendJsonl(this.file, entry);
  }
  list() { return readJsonl(this.file, 300).reverse(); }
}
module.exports = { Replay };
