// SPDX-License-Identifier: AGPL-3.0-only
// Local extension; its copyright is not assigned to Signal Messenger.
/* oxlint-disable signal-desktop/enforce-license-comments */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { Proto } from '@signalapp/mock-server';
import type { Device, PrimaryDevice, Server } from '@signalapp/mock-server';

export function tamperEnvelope(
  frame: Uint8Array<ArrayBuffer>
): Buffer<ArrayBuffer> {
  const envelope = Proto.Envelope.decode(frame);
  if (!envelope.content?.length) throw new Error('暗号文がありません');
  const content = Buffer.from(envelope.content);
  const lastByte = content[content.length - 1];
  if (lastByte === undefined) throw new Error('暗号文がありません');
  // Deliberately flip one ciphertext bit, leaving envelope metadata intact.
  // oxlint-disable-next-line eslint/no-bitwise
  content[content.length - 1] = lastByte ^ 1;
  return Buffer.from(Proto.Envelope.encode({ ...envelope, content }));
}

type Action =
  | 'normal'
  | 'tamper'
  | 'hold'
  | 'release'
  | 'replay'
  | 'arm-tamper'
  | 'arm-hold'
  | 'cancel';

export async function startAttackLab({
  server,
  desktop,
  alice,
  logsDir,
  senderDesktop,
  port = 8790,
}: {
  server: Server;
  desktop: Device;
  alice: PrimaryDevice;
  logsDir: string;
  senderDesktop?: Device;
  port?: number;
}): Promise<() => Promise<void>> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('観察パネルのポートは0から65535の整数にしてください');
  }
  const token = randomBytes(24).toString('hex');
  const started = Date.now();
  const events: Array<{ time: string; text: string }> = [];
  const record = (text: string) => {
    events.push({ time: new Date().toISOString(), text });
    if (events.length > 100) events.shift();
  };
  const originalSend = server.send.bind(server);
  let lastOriginal: Buffer<ArrayBuffer> | undefined;
  let held: Buffer<ArrayBuffer> | undefined;
  let armed: 'tamper' | 'hold' | undefined;
  let busy = false;
  let sequence = 0;
  let timestamp = Date.now();
  let latest:
    | { action: Action; sequence: number; timestamp: number; at: number }
    | undefined;

  // Desktop uploads are routed through Server.handleMessage -> this.send.
  // Mock primary devices retain their original bound send, so sample buttons
  // do not accidentally consume an armed Desktop interception.
  // oxlint-disable-next-line eslint/no-param-reassign -- local server hook, restored on close
  server.send = async (target, frame) => {
    const envelope = Proto.Envelope.decode(frame);
    if (
      !armed ||
      target !== desktop ||
      !envelope.content?.length ||
      envelope.type === Proto.Envelope.Type.SERVER_DELIVERY_RECEIPT ||
      (envelope.sourceDeviceId != null &&
        envelope.sourceDeviceId !== senderDesktop?.deviceId)
    ) {
      return originalSend(target, frame);
    }
    const mode = armed;
    armed = undefined;
    sequence += 1;
    timestamp = Number(envelope.clientTimestamp);
    held = Buffer.from(frame);
    lastOriginal = Buffer.from(frame);
    latest = { action: mode, sequence, timestamp, at: Date.now() };
    record(
      '送信側AliceのDesktopから受信側への暗号化パケットを捕捉しました。実験' +
        sequence
    );
    if (mode === 'tamper') {
      await originalSend(target, tamperEnvelope(frame));
      record('捕捉した暗号文を1バイト改ざんして配達。原本を保管しました。');
    } else
      record('捕捉した暗号文を保留しました。受信側にはまだ届けていません。');
  };

  async function run(action: Action): Promise<void> {
    if (busy) throw new Error('前の操作を処理中です');
    if (held && action !== 'release' && action !== 'cancel') {
      throw new Error(
        '先に「保管した原本を届ける」で現在の原本を届けてください'
      );
    }
    if (action === 'cancel') {
      armed = undefined;
      record('次の配達への介入を解除しました。');
      return;
    }
    if (action === 'arm-tamper' || action === 'arm-hold') {
      if (!senderDesktop) throw new Error('送信側Desktopがありません');
      armed = action === 'arm-tamper' ? 'tamper' : 'hold';
      record('待機中：送信側Aliceで受信側の会話にメッセージを送ってください。');
      return;
    }
    if (armed)
      throw new Error('送信側で送信するか、介入待機を解除してください');
    busy = true;
    try {
      if (action === 'release') {
        if (!held) throw new Error('保管した原本がありません');
        const frame = held;
        await originalSend(desktop, frame);
        held = undefined;
        record(
          '保管していた原本を配達しました。本文が表示されるか確認してください。'
        );
      } else if (action === 'replay') {
        if (!lastOriginal)
          throw new Error('先に通常配達などで暗号文を作ってください');
        await originalSend(desktop, Buffer.from(lastOriginal));
        record('最後の原本と同一の暗号文・時刻を再配達しました。');
      } else {
        sequence += 1;
        timestamp = Math.max(timestamp + 1, Date.now());
        const label = {
          normal: '通常',
          tamper: '改ざん対象',
          hold: '保留対象',
        }[action];
        record(
          `Aliceから「実験${sequence}：${label}メッセージ」を暗号化して送信。`
        );
        const frame = await alice.encryptText(
          desktop,
          `実験${sequence}：${label}メッセージ`,
          {
            timestamp,
          }
        );
        lastOriginal = Buffer.from(frame);
        if (action === 'hold') {
          held = Buffer.from(frame);
          record('中継地点で保留：アプリにはまだ届けていません。');
        } else if (action === 'tamper') {
          held = Buffer.from(frame);
          await originalSend(desktop, tamperEnvelope(frame));
          record(
            '暗号文の末尾1バイトを反転して配達。改ざん前の原本も保管しました。'
          );
        } else {
          await originalSend(desktop, frame);
          record('改ざんしていない暗号文を配達しました。');
        }
      }
      latest = { action, sequence, timestamp, at: Date.now() };
    } finally {
      busy = false;
    }
  }

  async function readObservations(): Promise<
    Array<{ time: string; text: string }>
  > {
    let file;
    try {
      file = await open(path.join(logsDir, 'app.log'), 'r');
      const { size } = await file.stat();
      const length = Math.min(size, 512 * 1024);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      return buffer
        .toString()
        .split('\n')
        .flatMap(line => {
          try {
            const value = JSON.parse(line);
            if (
              Date.parse(value.time) < started ||
              typeof value.msg !== 'string'
            )
              return [];
            if (
              !/Bad MAC|invalid.*(mac|message)|decryption.*(error|fail)|failed to decrypt|decrypt.*failed|DuplicateMessage|duplicate message|old counter|retry request|retry-request|retry placeholder|decrypted Whisper/i.test(
                value.msg
              )
            )
              return [];
            return [
              { time: String(value.time), text: value.msg.slice(0, 1600) },
            ];
          } catch {
            return [];
          }
        })
        .slice(-35);
    } catch {
      return [];
    } finally {
      await file?.close();
    }
  }

  const http = createServer((request, response) => {
    void (async () => {
      try {
        const address = http.address();
        if (!address || typeof address === 'string')
          throw new Error('Server address missing');
        const origin = `http://127.0.0.1:${address.port}`;
        if (
          request.headers.host !== `127.0.0.1:${address.port}` ||
          (request.headers.origin && request.headers.origin !== origin)
        ) {
          response.writeHead(403).end();
          return;
        }
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (request.method === 'GET' && request.url === '/') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
          );
          response.end(renderPanel(token));
        } else if (request.method === 'GET' && request.url === '/api/state') {
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              busy,
              held: Boolean(held),
              captured: Boolean(lastOriginal),
              latest,
              armed,
              events,
              observations: await readObservations(),
            })
          );
        } else if (
          request.method === 'POST' &&
          request.url?.startsWith('/api/')
        ) {
          const provided = request.headers['x-lab-token'];
          if (
            typeof provided !== 'string' ||
            !/^[a-f0-9]{48}$/.test(provided) ||
            !timingSafeEqual(Buffer.from(provided), Buffer.from(token))
          ) {
            response.writeHead(403).end();
            return;
          }
          const action = request.url.slice('/api/'.length);
          if (
            ![
              'normal',
              'tamper',
              'hold',
              'release',
              'replay',
              'arm-tamper',
              'arm-hold',
              'cancel',
            ].includes(action)
          ) {
            response.writeHead(404).end();
            return;
          }
          response.setHeader('Content-Type', 'application/json');
          try {
            await run(action as Action);
            response.end(JSON.stringify({ ok: true }));
          } catch (error) {
            response.writeHead(409).end(
              JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              })
            );
          }
        } else response.writeHead(404).end();
      } catch (error) {
        record(`操作画面のエラー：${String(error)}`);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    })();
  });
  http.requestTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => resolve());
  });
  record(
    '準備完了。SignalアプリでAliceの会話を開き、通常配達から比較してください。'
  );
  const address = http.address();
  if (!address || typeof address === 'string') {
    throw new Error('観察パネルのポートを確認できません');
  }
  console.log(`攻撃の観察パネル：http://127.0.0.1:${address.port}`);
  return async () => {
    // oxlint-disable-next-line eslint/no-param-reassign -- restore local server hook
    server.send = originalSend;
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close(error => (error ? reject(error) : resolve()))
    );
  };
}

export function renderPanel(token: string): string {
  return String.raw`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signal 攻撃の観察</title>
<style>body{font:16px/1.65 system-ui,sans-serif;background:#f4f6fb;color:#1b2743;margin:0}main{max-width:1080px;margin:40px auto;padding:0 24px}h1{font-size:30px;margin-bottom:8px}h2{font-size:19px}section{background:white;border:1px solid #d9dfeb;border-radius:16px;padding:24px;margin:20px 0}button{font:inherit;border:1px solid #bcc8e0;border-radius:9px;background:#eef3ff;color:#173d8c;padding:12px 16px;margin:6px;cursor:pointer}button:disabled{opacity:.4;cursor:default}#error{color:#ae2038}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;max-height:430px;overflow:auto}small{color:#54627c}.hint{border-left:4px solid #4269df;padding-left:14px}</style>
<main><small>ローカルデモ · 架空のAlice → Signal Desktop</small><h1>攻撃されたとき、アプリはどう動く？</h1>
<p>別ウィンドウのSignalアプリで<strong>Aliceの会話</strong>を開いてください。各ボタンはAliceからの新しいテスト文を作ります。すでにあるメッセージを書き換える操作ではありません。</p>
<p class="hint">悪意ある中継サーバーを想定した実験です。通信途中の第三者がTLSを破らず改ざんできるという意味ではありません。暗号化・認証処理は本物のlibsignalを使います。</p>
<section><h2>送信側のUIから試す</h2>
<p>「Signal — 送信側Alice」で「受信側」の会話に入力して送信します。「Signal — 受信側」ではAliceの会話を開いてください。通常はそのまま送信できます。</p>
<button data-action="arm-tamper">次の送信側→受信側の配達を改ざんする</button><button data-action="arm-hold">次の送信側→受信側の配達を保留する</button><button data-action="cancel">介入待機を解除する</button>
<p id="armed" aria-live="polite"></p><small>先に上のボタンを押し、その後AliceのUIから送信します。対象は次の暗号化パケット1通です。本文以外の既読通知などを先に送ると、それが対象になる場合があります。送信側のチェックマークと、受信側の本文・エラーを比較してください。改ざん・保留した原本は下の③で届けます。</small></section>
<section><h2>ボタンだけで試すサンプル配達</h2>
<p>①通常配達で本文を確認 → ②改ざんして<strong>原本を届けず10秒ほど観察</strong> → ③原本を届けて復旧を確認。</p>
<button data-action="normal">① 通常のテスト文を届ける</button><button data-action="tamper">② 新しいテスト文を1バイト改ざんして届ける</button><button data-action="release">③ 保管した正しい原本を届ける</button>
<div class="hint" aria-live="polite"><strong id="result">操作待ち</strong><p id="guidance">①を押して、SignalのAliceに「実験1：通常メッセージ」が届くことを確認してください。</p></div>
<p id="status"></p><p id="error" role="alert"></p>
<small>改ざんを拒否すると、本文は表示されません。エラー表示には待ち時間があり、先に原本を届けると出ない場合があります。下の「復号失敗」の記録も確認してください。</small>
<h2>追加の実験</h2><button data-action="replay">配達済みの同じ暗号文を再送する</button><button data-action="hold">新しいテスト文を途中で保留する</button>
<p><small>再送は配達済みの文の重複を試します。「保留」は1通だけを止める操作で、回線全体の切断ではありません。保管中は③で原本を届けてから次の実験に進みます。</small></p></section>
<section><h2>中継地点で実行した操作</h2><pre id="events"></pre></section>
<section><h2>アプリ・libsignalの実際の記録</h2><p><small>アプリのログから復号・重複・再送に関する行だけを抽出します。操作を実行しただけでは「拒否に成功」と判定しません。記録が出ない場合もあります。</small></p><pre id="observations"></pre></section>
<section><h2>観察のポイント</h2><p>改ざんした本文は表示される？ エラーは利用者に見える？ 原本を後で届けると復旧する？ 同じ文が二重に表示される？ 保留中もアプリは普通に使える？</p><small>会話データと実験記録はデモ終了時に消えます。外部の実ユーザー・実サーバーは対象にしません。</small></section></main>
<script>
const token=${JSON.stringify(token)};
let sending=false;
async function refresh(){
  try{
    const s=await(await fetch('/api/state')).json();
    document.getElementById('status').textContent=s.held?'正しい原本を1通保管中です。観察が済んだら③で届けてください。':'保管中の原本はありません。';
    document.getElementById('armed').textContent=s.armed?'介入待機中：送信側Aliceから受信側へ送信してください（'+(s.armed==='tamper'?'改ざん':'保留')+'）。':'介入待機なし。送信側UIから普通に送信できます。';
    for(const b of document.querySelectorAll('button'))b.disabled=sending||s.busy||(b.dataset.action==='release'&&!s.held)||(b.dataset.action==='replay'&&!s.captured)||(s.held&&b.dataset.action!=='release'&&b.dataset.action!=='cancel')||(s.armed&&!['cancel','arm-tamper','arm-hold'].includes(b.dataset.action));
    const last=s.latest;
    if(last){
      const lines=s.observations.filter(e=>e.text.includes(String(last.timestamp)));
      const failed=lines.some(e=>/decryption.*fail|failed to decrypt|decrypt.*failed/i.test(e.text));
      const duplicate=lines.some(e=>/DuplicateMessage|duplicate message|DuplicatedMessage/i.test(e.text));
      const names={normal:'通常の暗号文を配達しました',tamper:'改ざんした暗号文を配達しました',hold:'配達を保留しました',release:'正しい原本を配達しました',replay:'同一の暗号文を再送しました'};
      let result='実験'+last.sequence+'：'+names[last.action];
      let guidance='SignalのAliceの会話を確認してください。';
      if(last.action==='normal')guidance='「実験'+last.sequence+'：通常メッセージ」が表示されるか確認してください。次は②で比較できます。';
      if(last.action==='tamper'){
        if(failed)result='実験'+last.sequence+'：アプリの復号失敗をログで確認しました';
        guidance='操作から'+Math.floor((Date.now()-last.at)/1000)+'秒。改ざん対象の本文は表示されないはずです。まず10秒ほど、原本を届けずAliceの会話を観察してください。エラー表示の有無も観察対象です。その後③で正しい原本を届けます。';
      }
      if(last.action==='release')guidance='保管した原本の本文が受信側のAliceの会話に表示されるか確認してください。';
      if(last.action==='hold')guidance='まだアプリには届けていないので、会話に変化がないのが予想される動作です。③で配達します。';
      if(last.action==='replay'){
        if(duplicate)result='実験'+last.sequence+'：重複の検出をログで確認しました';
        guidance='同じ文がもう1通増えるか確認してください。重複を拒否すれば、会話に新しい本文は増えません。';
      }
      document.getElementById('result').textContent=result;
      document.getElementById('guidance').textContent=guidance;
    }
    for(const key of ['events','observations'])document.getElementById(key).textContent=s[key].map(e=>e.time+'  '+e.text).join('\n\n')||'まだ記録はありません。';
  }catch{document.getElementById('status').textContent='デモに接続できません。起動ターミナルを確認してください。';}
}
for(const b of document.querySelectorAll('button'))b.onclick=async()=>{
  sending=true;
  document.getElementById('error').textContent='';
  await refresh();
  try{
    const r=await fetch('/api/'+b.dataset.action,{method:'POST',headers:{'X-Lab-Token':token}});
    if(!r.ok)throw Error((await r.json()).error||'操作に失敗しました');
  }catch(e){document.getElementById('error').textContent=e.message;}
  finally{sending=false;await refresh();}
};
refresh();setInterval(refresh,1500);
</script></html>`;
}
