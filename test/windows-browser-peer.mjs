import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, extname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

export async function browserPeer(work, errors, options = {}) {
  assert.equal(process.platform, "win32", "Use the bounded Windows runner");
  const profile = resolve(work, `chrome-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  let executable;
  for (const root of [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA,
  ]) {
    if (!root) continue;
    const candidate = resolve(root, "Google/Chrome/Application/chrome.exe");
    try {
      await access(candidate);
      executable = candidate;
      break;
    } catch {
      /* Try the next installation. */
    }
  }
  assert(executable, "Windows Chrome is not installed");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (await options.serve?.(request, response, path)) return;
    const allowed =
      /^\/(web-build\/core-probe\.(mjs|wasm)|repo\/client\/[a-z-]+\.js|player-[12]\.gba)$/;
    if (path === "/") {
      response.end(
        "<!doctype html><title>Cable qualification</title><p>Isolated netplay test</p>",
      );
      return;
    }
    if (!allowed.test(path)) {
      response.writeHead(404).end();
      return;
    }
    try {
      response.setHeader(
        "Content-Type",
        extname(path) === ".wasm"
          ? "application/wasm"
          : /\.(mjs|js)$/.test(path)
            ? "text/javascript"
            : "application/octet-stream",
      );
      response.end(await readFile(resolve(work, path.slice(1))));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const child = spawn(
    executable,
    [
      ...(options.headless === false ? [] : ["--headless=new"]),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      ...(options.hardwareAcceleration ? [] : ["--disable-gpu"]),
      ...(options.args ?? []),
      "--renderer-process-limit=1",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  child.on("error", (error) => errors.push(error.message));
  let socket,
    next = 0,
    sessionId;
  const pending = new Map();
  const close = async () => {
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        await command("Browser.close", {}, false);
      } catch {
        /* Job cleanup is the fallback. */
      }
    }
    socket?.terminate();
    if (child.exitCode === null) child.kill();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  };
  function command(method, params = {}, scoped = true) {
    const id = ++next;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      pending.set(id, { done, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(scoped && sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  async function evaluate(expression) {
    const reply = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert(
      !reply.exceptionDetails,
      reply.exceptionDetails?.exception?.description ??
        "Browser evaluation failed",
    );
    return reply.result.value;
  }
  try {
    let endpoint;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const [port, path] = (
          await readFile(resolve(profile, "DevToolsActivePort"), "utf8")
        )
          .trim()
          .split(/\r?\n/);
        endpoint = `ws://127.0.0.1:${port}${path}`;
        break;
      } catch {
        await delay(50);
      }
    }
    assert(endpoint, "Windows Chrome did not expose CDP");
    socket = new WebSocket(endpoint);
    await new Promise((done, reject) => {
      socket.once("open", done);
      socket.once("error", reject);
    });
    socket.on("message", (bytes) => {
      const packet = JSON.parse(bytes);
      if (!packet.id) options.onEvent?.(packet);
      if (packet.method === "Target.targetCrashed")
        errors.push(`Browser target crashed: ${packet.params.status}`);
      const waiter = pending.get(packet.id);
      if (waiter) {
        pending.delete(packet.id);
        clearTimeout(waiter.timer);
        if (packet.error) waiter.reject(new Error(packet.error.message));
        else waiter.done(packet.result);
      } else if (packet.method === "Runtime.exceptionThrown")
        errors.push(
          packet.params.exceptionDetails.exception?.description ??
            "Browser exception",
        );
    });
    const { targetId } = await command("Target.createTarget", {
      url: options.url ?? `http://127.0.0.1:${server.address().port}/`,
    });
    ({ sessionId } = await command("Target.attachToTarget", {
      targetId,
      flatten: true,
    }));
    await command("Runtime.enable");
    if (options.initialize === false)
      return {
        evaluate,
        command,
        close,
        origin: `http://127.0.0.1:${server.address().port}`,
      };
    const size = await evaluate(`(async () => {
      const { default: init } = await import('/web-build/core-probe.mjs');
      const { linkCore } = await import('/repo/client/link-core.js');
      const { BridgeConnection } = await import('/repo/client/bridge-session.js');
      const core = await init({ print() {}, printErr() {} });
      const pointers = [];
      for (const player of [1, 2]) {
        const bytes = new Uint8Array(await (await fetch('/player-' + player + '.gba')).arrayBuffer());
        const pointer = core._malloc(bytes.length); core.HEAPU8.set(bytes, pointer); pointers.push([pointer, bytes.length]);
      }
      if (!core._probe_init_pair(...pointers.flat())) throw new Error('Browser core load failed');
      core._probe_step(0, 0, 0, 0);
      const size = core._probe_size(), pointer = core._malloc(size);
      window.peerErrors = [];
      window.adapter = { size, profile: linkCore('mgba_splitscreen'),
        save() { if (!core._probe_save(pointer, size)) throw new Error('Browser save failed'); return core.HEAPU8.slice(pointer, pointer + size); },
        load(bytes) { core.HEAPU8.set(bytes, pointer); if (!core._probe_load(pointer, size)) throw new Error('Browser restore failed'); },
        memory(id) { return core.HEAPU8.slice(core._probe_memory(id), core._probe_memory(id) + core._probe_memory_size(id)); },
        loadMemory(id, bytes) { core.HEAPU8.set(bytes, core._probe_memory(id)); },
        stepPlayers(buttons) { core._probe_step(buttons[0] ?? 0, buttons[1] ?? 0, 0, 0); } };
      window.connectPeer = (url, player) => {
        window.peer?.stop(); clearInterval(window.peerTimer);
        window.peer = new BridgeConnection(window.adapter, new WebSocket(url), {
          player, players: 2, maxPrediction: 12,
          onError: e => window.peerErrors.push(e.message), onActionError: e => window.peerErrors.push(e) });
        window.peerTimer = setInterval(() => { if (window.peer.started) window.peer.tick(window.peer.session.frame % 90 < 12 ? 256 : 0); }, 16);
      };
      window.peerSnapshot = () => {
        const bytes = window.peer.session ? window.peer.session.stateAt(window.peer.session.confirmed) : window.adapter.save();
        let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192));
        return { state: btoa(text), frame: window.peer.session?.frame, confirmed: window.peer.session?.confirmed,
          stats: window.peer.session?.stats, errors: window.peerErrors };
      };
      return size;
    })()`);
    return { size, browser: true, evaluate, close };
  } catch (error) {
    await close();
    throw error;
  }
}
