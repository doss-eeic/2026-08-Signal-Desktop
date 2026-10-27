// SPDX-License-Identifier: AGPL-3.0-only
// Local extension: do not assign its copyright to Signal Messenger.
/* oxlint-disable signal-desktop/enforce-license-comments */
// Provisioning/key queues and auto-replies must be consumed in order.
/* oxlint-disable eslint/no-await-in-loop */
// Uses Signal's mock protocol server, without browser/desktop automation.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import {
  Server,
  ServiceIdKind,
  StorageState,
  loadCertificates,
} from '@signalapp/mock-server';
// This launcher intentionally reuses the official integration-test setup.
// oxlint-disable-next-line signal-desktop/no-restricted-paths
import { Bootstrap } from '../ts/test-mock/bootstrap.node.ts';
import type { Device, PrimaryDevice } from '@signalapp/mock-server';
import { startAttackLab } from './local-attack-lab.node.ts';

async function replyLoop(
  contact: PrimaryDevice,
  desktop: Device,
  isStopping: () => boolean
): Promise<void> {
  try {
    while (!isStopping()) {
      const message = await contact.waitForMessage();
      if (!message.body || message.source.aci !== desktop.aci) continue;
      await contact.sendText(desktop, `受け取りました：${message.body}`, {
        timestamp: Date.now(),
      });
    }
  } catch (error) {
    if (!isStopping()) console.error('自動返信エラー:', error);
  }
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..');
  const mediaPath = await mkdtemp(
    path.join(os.tmpdir(), 'signal-local-demo-media-')
  );
  const server = new Server({
    cdn3Path: mediaPath,
    updates2Path: path.join(root, 'ts/test-mock/updates-data'),
  });
  const bootstrap = new Bootstrap({
    server,
    contactCount: 2,
    contactNames: ['Alice', 'Bob'],
    linkedDevices: 0,
  });
  const senderBootstrap = new Bootstrap({
    server,
    contactCount: 0,
    linkedDevices: 0,
  });
  const children: Array<ReturnType<typeof spawn>> = [];
  let stopping = false;
  let closeAttackLab: (() => Promise<void>) | undefined;
  const isStopping = () => stopping;
  async function stop(code = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    await closeAttackLab?.();
    for (const child of children) {
      if (child.exitCode != null || child.signalCode != null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([
        exited,
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
      if (child.exitCode == null && child.signalCode == null)
        child.kill('SIGKILL');
    }
    await senderBootstrap.teardown();
    await bootstrap.teardown();
    await server.close();
    await rm(mediaPath, { recursive: true, force: true });
    process.exit(code);
  }
  process.on('SIGINT', () => {
    void stop();
  });
  process.on('SIGTERM', () => {
    void stop();
  });
  try {
    await server.listen(0, '127.0.0.1');
    await bootstrap.init();
    await senderBootstrap.init();
    let senderElectron = electronPath as unknown as string;
    if (process.platform === 'darwin') {
      // A separate development bundle gives macOS two distinct app identities.
      const bundle = path.join(mediaPath, 'Signal Demo Sender.app');
      const originalBundle = path.resolve(senderElectron, '../../..');
      const exec = promisify(execFile);
      await exec('/bin/cp', ['-cR', originalBundle, bundle]);
      await exec('/usr/libexec/PlistBuddy', [
        '-c',
        'Set :CFBundleIdentifier org.signal.local-demo.sender',
        path.join(bundle, 'Contents/Info.plist'),
      ]);
      await exec('/usr/libexec/PlistBuddy', [
        '-c',
        'Set :CFBundleName Signal Demo Sender',
        path.join(bundle, 'Contents/Info.plist'),
      ]);
      await exec('/usr/bin/codesign', [
        '--force',
        '--deep',
        '--sign',
        '-',
        bundle,
      ]);
      senderElectron = path.join(bundle, 'Contents/MacOS/Electron');
    }
    let state = StorageState.getEmpty();
    for (const contact of bootstrap.contacts) {
      state = state.addContact(contact, {
        identityKey: contact.publicKey.serialize(),
        profileKey: contact.profileKey.serialize(),
        whitelisted: true,
      });
    }
    await bootstrap.phone.setStorageState(state);
    const url = `https://127.0.0.1:${server.address().port}`;
    const config = {
      ...(await loadCertificates()),
      ciMode: 'full',
      buildExpiration: Date.now() + 30 * 24 * 60 * 60 * 1000,
      storagePath: path.dirname(bootstrap.ephemeralConfigPath),
      storageProfile: 'local-demo',
      serverUrl: url,
      storageUrl: `${url}/storageService`,
      resourcesUrl: `${url}/updates2`,
      sfuUrl: `${url}/callingService`,
      cdn: { '0': url, '2': url, '3': `${url}/cdn3` },
      directoryCDSIUrl: url,
      directoryCDSIMRENCLAVE:
        '51133fecb3fa18aaf0c8f64cb763656d3272d9faaacdb26ae7df082e414fb142',
      updatesEnabled: false,
      openDevTools: false,
    };
    async function launchDesktop(
      instance: Bootstrap,
      primary: PrimaryDevice,
      contacts: ReadonlyArray<PrimaryDevice>,
      role: string
    ): Promise<Device> {
      // Attach a rejection handler immediately; the mock queue has its own timeout.
      const provisionPromise = (async () => {
        try {
          return { value: await server.waitForProvision() };
        } catch (error) {
          return { error };
        }
      })();
      console.log(
        'ローカルデモを起動します。実際の電話・アカウントは使いません。'
      );
      const child = spawn(
        role === '送信側Alice'
          ? senderElectron
          : (electronPath as unknown as string),
        [path.join(root, 'local-demo.main.mjs')],
        {
          cwd: root,
          env: {
            ...process.env,
            MOCK_TEST: 'true',
            SIGNAL_LOCAL_DEMO: '1',
            SIGNAL_LOCAL_DEMO_ROLE: role,
            SIGNAL_CI_CONFIG: JSON.stringify({
              ...config,
              storagePath: path.dirname(instance.ephemeralConfigPath),
              storageProfile: role,
            }),
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        }
      );
      children.push(child);
      // Keep logs local; do not echo private provisioning material to the terminal.
      child.stderr?.on('data', data => {
        if (process.env.SIGNAL_DEMO_DEBUG) process.stderr.write(data);
      });
      child.stdout?.on('data', data => {
        if (process.env.SIGNAL_DEMO_DEBUG) process.stdout.write(data);
      });
      const appProcess = child;
      const childExit = (async () => {
        try {
          const [code] = await once(appProcess, 'exit');
          await stop(typeof code === 'number' ? code : 1);
        } catch (error) {
          console.error('デモプロセスエラー:', error);
          await stop(1);
        }
      })();
      const provisionUrl = await Promise.race([
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Demo setup timed out')),
            60000
          );
          appProcess.on('message', message => {
            if (
              typeof message === 'object' &&
              message != null &&
              'type' in message &&
              message.type === 'provision' &&
              'url' in message &&
              typeof message.url === 'string'
            ) {
              clearTimeout(timer);
              resolve(message.url);
            }
          });
          appProcess.once('error', reject);
        }),
        (async () => {
          await childExit;
          throw new Error('Demo app exited during setup');
        })(),
      ]);
      const result = await provisionPromise;
      if ('error' in result) throw result.error;
      const provision = result.value;
      const desktop = await provision.complete({
        provisionURL: provisionUrl,
        primaryDevice: primary,
      });
      await primary.addSingleUseKey(desktop, await desktop.popSingleUseKey());
      for (const contact of contacts) {
        await contact.addSingleUseKey(
          desktop,
          await desktop.popSingleUseKey(ServiceIdKind.ACI),
          ServiceIdKind.ACI
        );
        if (desktop.pni) {
          await contact.addSingleUseKey(
            desktop,
            await desktop.popSingleUseKey(ServiceIdKind.PNI),
            ServiceIdKind.PNI
          );
        }
      }
      await primary.waitForSync(desktop);
      return desktop;
    }
    const desktop = await launchDesktop(
      bootstrap,
      bootstrap.phone,
      bootstrap.contacts,
      '受信側'
    );
    const alice = bootstrap.contacts[0];
    if (!alice) throw new Error('デモ用のAliceが作成されていません');
    await alice.setStorageState(
      StorageState.getEmpty().addContact(bootstrap.phone, {
        identityKey: bootstrap.phone.publicKey.serialize(),
        profileKey: bootstrap.phone.profileKey.serialize(),
        whitelisted: true,
        systemGivenName: '受信側',
      })
    );
    const senderDesktop = await launchDesktop(
      senderBootstrap,
      alice,
      [bootstrap.phone],
      '送信側Alice'
    );
    await bootstrap.phone.sendText(
      senderDesktop,
      'こちらが受信側です。この会話に送信すると、もう一方のSignalで受信できます。',
      { timestamp: Date.now() }
    );
    const greetings = [
      'こんにちは！これはPC内だけで動くSignalのデモです。自由にメッセージを送ってみてください。',
      'Bobです。絵文字やリアクション、メッセージの編集などを試してみてね。',
    ];
    for (const [index, contact] of bootstrap.contacts.entries()) {
      const greeting = greetings[index];
      if (greeting === undefined)
        throw new Error('デモ用の挨拶が設定されていません');
      await contact.sendText(desktop, greeting, {
        timestamp: Date.now() + index,
      });
      if (index !== 0) void replyLoop(contact, desktop, isStopping);
    }
    console.log(
      '準備完了：Alice / Bob と会話できます。終了するとデモデータは消えます。'
    );
    closeAttackLab = await startAttackLab({
      server,
      desktop,
      alice,
      logsDir: bootstrap.logsDir,
      senderDesktop,
    });
  } catch (error) {
    console.error('ローカルデモの起動に失敗:', error);
    await stop(1);
  }
}

void main();
