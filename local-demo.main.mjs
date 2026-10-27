// SPDX-License-Identifier: AGPL-3.0-only
// This local extension does not claim Signal Messenger copyright ownership.
/* oxlint-disable signal-desktop/enforce-license-comments */
// Like ci.js, this unbundled entry must live at the app root.
// Electron entry point used exclusively by local-demo.node.ts.
import process from 'node:process';
import { createRequire } from 'node:module';
import { app, ipcMain } from 'electron';

const require = createRequire(import.meta.url);

if (process.env.SIGNAL_LOCAL_DEMO !== '1' || !process.send) {
  throw new Error('Start this app with start-signal-demo.command');
}

app.on('browser-window-created', (_event, window) => {
  window.on('page-title-updated', event => {
    event.preventDefault();
    window.setTitle(
      `Signal — ${process.env.SIGNAL_LOCAL_DEMO_ROLE ?? 'ローカルデモ'}`
    );
  });
});

ipcMain.on('local-demo:provision-url', (event, url) => {
  const senderUrl = event.sender.getURL();
  if (senderUrl.startsWith('file:') && typeof url === 'string') {
    process.send({ type: 'provision', url });
  }
});

require('./ci.js');
