import assert from "node:assert/strict";
import { createReadStream, appendFileSync } from "node:fs";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { browserPeer } from "./windows-browser-peer.mjs";
import { verifyWfcControls } from "./windows-wfc-controls.mjs";

const work = process.argv[2],
  mode = process.argv[3] ?? "boot";
const account = JSON.parse(
  await readFile(resolve(work, "account.json"), "utf8"),
);
const errors = [],
  evidence = resolve(work, "evidence");
const checkpoint = await stat(resolve(work, "checkpoint.state")).then(
  () => true,
  () => false,
);
const userSave = await stat(resolve(work, "user-save.srm")).then(
  () => true,
  () => false,
);
const scenario = ["progress", "wfc"].includes(mode)
  ? JSON.parse(await readFile(resolve(work, "scenario.json"), "utf8"))
  : [];
await mkdir(evidence, { recursive: true });
await writeFile(resolve(evidence, "console.jsonl"), "");
let stage = "navigation";
const peer = await browserPeer(work, errors, {
  url: "http://127.0.0.1:8081/assets/emulatorjs/data/",
  initialize: false,
  headless: false,
  hardwareAcceleration: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--force-device-scale-factor=1",
  ],
  onEvent: (packet) => {
    if (packet.method === "Debugger.paused") {
      appendFileSync(
        resolve(evidence, "paused.jsonl"),
        JSON.stringify(
          packet.params.callFrames.map((frame) => ({
            function: frame.functionName,
            location: frame.location,
          })),
        ) + "\n",
      );
    }
    if (packet.method === "Runtime.consoleAPICalled") {
      const text = packet.params.args
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(" ")
        .replace(/token=[A-Za-z0-9_-]+/g, "token=[redacted]");
      appendFileSync(
        resolve(evidence, "console.jsonl"),
        JSON.stringify({ time: Date.now(), text }) + "\n",
      );
    }
  },
  serve: async (request, response, path) => {
    response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:8081");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.end();
      return true;
    }
    if (path === "/checkpoint.state" && request.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const bytes of request) {
        size += bytes.length;
        if (size > 64 * 1024 * 1024) throw new Error("Test state too large");
        chunks.push(bytes);
      }
      await writeFile(
        resolve(evidence, "checkpoint.state"),
        Buffer.concat(chunks),
      );
      response.end();
      return true;
    }
    if (
      ![
        "/pokemon.nds",
        "/melondsds-wasm.data",
        "/melondsds.json",
        "/checkpoint.state",
        "/user-save.srm",
      ].includes(path)
    )
      return false;
    const file = resolve(work, path.slice(1));
    response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:8081");
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Length", (await stat(file)).size);
    createReadStream(file).pipe(response);
    return true;
  },
});
try {
  await peer.command(
    "Security.setIgnoreCertificateErrors",
    { ignore: true },
    false,
  );
  await peer.command("Emulation.setDeviceMetricsOverride", {
    width: 800,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await peer.command("Page.enable");
  if (mode === "controls") {
    await peer.command("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
  }
  await peer.command("Page.bringToFront");
  await peer.command("Debugger.enable");
  const navigation = await peer.command("Page.navigate", {
    url: "http://127.0.0.1:8081/assets/emulatorjs/data/",
  });
  assert.ok(!navigation.errorText, navigation.errorText);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      await peer.evaluate(
        "location.origin === 'http://127.0.0.1:8081' && document.readyState !== 'loading'",
      )
    )
      break;
    await delay(100);
  }
  stage = "login";
  const login = await peer.evaluate(`(async () => {
    const response = await fetch('/api/login', {method:'POST', headers: {Authorization:'Basic '+${JSON.stringify(Buffer.from(`${account.username}:${account.password}`).toString("base64"))}}});
    await fetch('/api/users/me'); return response.status;
  })()`);
  assert.equal(login, 200);
  stage = "load-game";
  await peer.evaluate(`(async () => {
    document.body.innerHTML='<div id="game" style="width:768px;height:850px"></div>';
    window.testLogs=[];
    for (const kind of ['log','warn','error']) { const previous=console[kind].bind(console); console[kind]=(...args)=>{ testLogs.push(args.map(x=>String(x)).join(' ').slice(0,700)); if(testLogs.length>150)testLogs.shift(); previous(...args); }; }
    Object.assign(window, {EJS_player:'#game', EJS_core:'melondsds', EJS_controlScheme:'nds',
      EJS_pathtodata:'/assets/emulatorjs/data/', EJS_gameUrl:${JSON.stringify(peer.origin + "/pokemon.nds")},
      EJS_paths:${JSON.stringify({ "melondsds-wasm.data": peer.origin + "/melondsds-wasm.data", "melondsds.json": peer.origin + "/melondsds.json" })},
      EJS_gameID:14, EJS_gameName:'WFC qualification', EJS_startOnLoaded:true, EJS_threads:false,
      EJS_DEBUG_XX:true, EJS_volume:0, EJS_language:'en-US', EJS_disableAutoLang:true});
    ${mode === "controls" ? `window.EJS_browserMode=1; window.EJS_defaultOptions={lockMouse:'enabled', ejs_threads:'enabled'};` : ""}
    ${
      userSave
        ? `const saveResponse=await fetch(${JSON.stringify(peer.origin + "/user-save.srm")});
    if(!saveResponse.ok)throw new Error('User save download failed');
    const save=new Uint8Array(await saveResponse.arrayBuffer());
    if(save.length!==524288)throw new Error('Unexpected Diamond save size');
    window.EJS_ready=()=>EJS_emulator.on('saveDatabaseLoaded',fs=>{
      const path='/data/saves/melonDS DS/pokemon.srm'; fs.mkdirTree('/data/saves/melonDS DS'); fs.writeFile(path,save);
      window.testUserSave={path,bytes:save.length};
    });`
        : ""
    }
    ${checkpoint && ["progress", "controls"].includes(mode) ? `window.EJS_loadStateURL=${JSON.stringify(peer.origin + "/checkpoint.state")};` : ""}
    const loader=document.createElement('script'); loader.src='/assets/emulatorjs/data/loader.js?v=wfc-controls-20261107.2'; document.body.append(loader);
  })()`);
  appendFileSync(
    resolve(evidence, "console.jsonl"),
    JSON.stringify({ stage: "waiting-for-game" }) + "\n",
  );
  let status;
  for (let attempt = 0; attempt < 150; attempt++) {
    status = await peer.evaluate(
      `({started:!!window.EJS_emulator?.started, text:document.querySelector('.ejs_loading_text')?.textContent})`,
    );
    if (
      status.started ||
      (status.text && /failed|error|unavailable/i.test(status.text))
    )
      break;
    await delay(100);
  }
  if (status.started) {
    await peer.evaluate(`(() => {
      const session=EJS_emulator.wfcSession;
      window.testNetwork={sent:0,received:0,destinations:{},packets:[]};
      const record=(direction,bytes)=>{if(bytes[12]!==8||bytes[13]!==0||testNetwork.packets.length>=100)return;
        const ip=at=>Array.from(bytes.slice(at,at+4)).join('.');
        const port=at=>(bytes[at]<<8)|bytes[at+1];
        let dnsQuestion;
        if(bytes[23]===17 && (port(34)===53 || port(36)===53) && bytes.length>54) {
          const labels=[]; let p=54;
          while(p<bytes.length && bytes[p]>0 && bytes[p]<64) {const n=bytes[p++]; labels.push(String.fromCharCode(...bytes.subarray(p,p+n))); p+=n;}
          dnsQuestion=labels.join('.');
        }
        testNetwork.packets.push({direction,time:Date.now(),source:ip(26),destination:ip(30),protocol:bytes[23],sourcePort:port(34),destinationPort:port(36),tcpFlags:bytes[23]===6?bytes[47]:undefined,dnsQuestion,length:bytes.length});};
      const send=session.send.bind(session), receive=session.receive.bind(session);
      session.send=bytes=>{testNetwork.sent++; record('out',bytes); if(bytes[12]===8&&bytes[13]===0){const ip=Array.from(bytes.slice(30,34)).join('.'); testNetwork.destinations[ip]=(testNetwork.destinations[ip]||0)+1;} return send(bytes);};
      session.receive=()=>{const bytes=receive(); if(bytes){testNetwork.received++; record('in',bytes);} return bytes;};
    })()`);
    await peer.evaluate(
      "EJS_emulator.gameManager.functions.setKeyboardEnabled(0)",
    );
    await delay(5000);
    if (
      mode !== "boot" &&
      !(["progress", "controls"].includes(mode) && checkpoint)
    ) {
      for (let i = 0; i < 4; i++) {
        await peer.evaluate(
          `EJS_emulator.gameManager.functions.simulateInput(0, 3, 1)`,
        );
        await delay(100);
        await peer.evaluate(
          `EJS_emulator.gameManager.functions.simulateInput(0, 3, 0)`,
        );
        await delay(2000);
        const menu = await peer.command("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          resolve(evidence, `menu-${i + 1}.png`),
          Buffer.from(menu.data, "base64"),
        );
      }
    }
    if (mode === "wfc") await delay(2000);
    if (["progress", "wfc"].includes(mode)) {
      for (const [index, action] of scenario.entries()) {
        if (Number.isInteger(action.key)) {
          await peer.evaluate(
            `EJS_emulator.gameManager.functions.simulateInput(0, ${action.key}, 1)`,
          );
          await delay(100);
          await peer.evaluate(
            `EJS_emulator.gameManager.functions.simulateInput(0, ${action.key}, 0)`,
          );
        }
        if (action.tap) {
          const point = await peer.evaluate(
            `(() => { const r=EJS_emulator.canvas.getBoundingClientRect(), w=r.height*2/3; return {x:r.x+(r.width-w)/2+w*${action.tap[0]}/256,y:r.y+r.height*${action.tap[1]}/384}; })()`,
          );
          const geometry = await peer.evaluate(
            `(() => {const c=EJS_emulator.canvas;return {rect:c.getBoundingClientRect().toJSON(),width:c.width,height:c.height,dpr:devicePixelRatio};})()`,
          );
          appendFileSync(
            resolve(evidence, "console.jsonl"),
            JSON.stringify({ tap: action.tap, point, geometry }) + "\n",
          );
          await peer.command("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            ...point,
            buttons: 0,
          });
          await delay(100);
          await peer.command("Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...point,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          await delay(300);
          const pressed = await peer.command("Page.captureScreenshot", {
            format: "png",
          });
          await writeFile(
            resolve(evidence, `pressed-${index + 1}.png`),
            Buffer.from(pressed.data, "base64"),
          );
          await peer.command("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...point,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
        }
        await delay(action.waitMs ?? 400);
        const screen = await peer.command("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          resolve(evidence, `action-${index + 1}.png`),
          Buffer.from(screen.data, "base64"),
        );
      }
    }
    if (mode === "controls") await verifyWfcControls(peer, evidence);
    await delay(mode === "controls" ? 1000 : 5000);
    if (!["boot", "controls"].includes(mode)) {
      await peer.evaluate(
        `(async () => { const bytes=EJS_emulator.gameManager.getState(); const response=await fetch(${JSON.stringify(peer.origin + "/checkpoint.state")},{method:'POST',body:bytes}); if(!response.ok)throw new Error('Test state export failed'); })()`,
      );
    }
  }
  const details = await peer.evaluate(
    `(() => {const e=window.EJS_emulator;return {started:!!e?.started, core:e?.getCore(), frame:e?.gameManager?.functions?.getFrameNum?.(), memory:e?.Module?.HEAPU8?.byteLength, wfc:e?.wfcSession?.socket?.readyState, network:window.testNetwork, userSave:window.testUserSave, savePath:e?.gameManager?.getSaveFilePath(), text:document.body.innerText.slice(0,500),logs:window.testLogs};})()`,
  );
  const screenshot = await peer.command("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(
    resolve(evidence, "screen.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  await writeFile(
    resolve(evidence, "result.json"),
    JSON.stringify({ ...details, errors }, null, 2),
  );
  console.log(
    JSON.stringify({
      started: details.started,
      core: details.core,
      frame: details.frame,
      memory: details.memory,
      wfc: details.wfc,
      errors,
    }),
  );
  assert.ok(details.started, details.text);
  assert.ok(details.frame > 30);
  assert.equal(details.wfc, 1);
  if (mode === "wfc")
    assert.ok(details.network?.sent > 0, "The scenario did not reach Nintendo WFC");
  if (userSave) assert.equal(details.userSave?.path, details.savePath);
} catch (error) {
  await writeFile(
    resolve(evidence, "failure.json"),
    JSON.stringify({ stage, error: error.message, errors }, null, 2),
  );
  await peer.command("Debugger.enable").catch(() => {});
  await peer.command("Debugger.pause").catch(() => {});
  const screenshot = await peer
    .command("Page.captureScreenshot", { format: "png" })
    .catch(() => null);
  if (screenshot)
    await writeFile(
      resolve(evidence, "failure.png"),
      Buffer.from(screenshot.data, "base64"),
    );
  await peer.command("Debugger.resume").catch(() => {});
  throw error;
} finally {
  await peer
    .evaluate("window.EJS_emulator?.wfcSession?.close()")
    .catch(() => {});
  await peer.close();
}
