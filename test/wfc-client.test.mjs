import assert from "node:assert/strict";
import test from "node:test";
import { WfcSession } from "../client/wfc-session.js";

test("WFC restores the account console and uploads settings without changing its MAC", async (t) => {
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
    send(bytes) {
      this.sent = bytes.slice();
    }
  }
  t.mock.method(globalThis, "setInterval", () => 1);
  const oldSocket = globalThis.WebSocket,
    oldWindow = globalThis.window;
  globalThis.WebSocket = Socket;
  globalThis.window = new EventTarget();
  t.after(() => {
    globalThis.WebSocket = oldSocket;
    globalThis.window = oldWindow;
  });
  const files = new Map(),
    directories = [];
  const manager = {
    Module: {},
    FS: {
      mkdirTree: (path) => directories.push(path),
      readFile: (path) => files.get(path),
    },
    writeFile: (path, bytes) => files.set(path, bytes),
  };
  const session = new WfcSession(manager);
  const requests = [];
  session.request = async (path, method, body) => {
    requests.push({ path, method, body });
    return {
      websocket_url: "ws://localhost",
      profile: { mac: "0209bf112233", firmware: "AQID" },
    };
  };
  try {
    await session.connect(14);
    assert.equal(manager.Module.rommWfc, session);
    assert.deepEqual([...session.mac], [2, 9, 191, 17, 34, 51]);
    assert.deepEqual(directories, ["/melonDS DS"]);
    assert.deepEqual([...files.get("/melonDS DS/wfcsettings.bin")], [1, 2, 3]);
    assert.equal(session.send(Uint8Array.of(1, 2)), 2);
    files.set("/melonDS DS/wfcsettings.bin", Uint8Array.of(4, 5, 6));
    await session.saveSettings();
    assert.deepEqual(requests.at(-1), {
      path: "settings",
      method: "PUT",
      body: { mac: "0209bf112233", firmware: "BAUG" },
    });
    await session.saveSettings();
    assert.equal(requests.length, 2);
    session.close();
    assert.equal(session.send(Uint8Array.of(1)), 0);
  } finally {
    session.close();
  }
});
