import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function verifyWfcControls(peer, evidence) {
  const settings = await peer.evaluate(`(() => {
    const e=EJS_emulator;
    localStorage.setItem(e.getLocalStorageKey(),JSON.stringify({controlSettings:e.controls,settings:{lockMouse:'enabled'},cheats:[]}));
    e.loadSettings();
    window.testControlState=e.gameManager.getState().slice();
    window.testTouches=[];
    for(const type of ['touchstart','touchmove','touchend','touchcancel'])
      e.canvas.addEventListener(type,event=>testTouches.push({type,touches:event.touches.length,targetTouches:event.targetTouches.length}));
    return {touch:e.hasTouchScreen,lock:e.enableMouseLock,savedLock:e.allSettings.lockMouse,
      pointerEvents:getComputedStyle(e.canvas).pointerEvents,touchAction:getComputedStyle(e.canvas).touchAction,
      lockOption:!!document.querySelector('[data-ejs-option="lockMouse"]'),
      threadOption:!!document.querySelector('[data-ejs-option="ejs_threads"]')};
  })()`);
  assert.equal(settings.touch, true);
  assert.equal(settings.lock, false);
  assert.equal(settings.savedLock, "disabled");
  assert.equal(settings.pointerEvents, "auto");
  assert.equal(settings.touchAction, "none");
  assert.equal(settings.lockOption, false);
  assert.equal(settings.threadOption, false);

  const screenshot = async (name) => {
    const result = await peer.command("Page.captureScreenshot", {
      format: "png",
    });
    await writeFile(
      resolve(evidence, name + ".png"),
      Buffer.from(result.data, "base64"),
    );
  };
  const point = await peer.evaluate(`(() => {
    const c=EJS_emulator.canvas,r=c.getBoundingClientRect(),w=r.height*2/3;
    const x=r.x+(r.width-w)/2+w*220/256,y=r.y+r.height*260/384;
    return {x,y,canvas:document.elementFromPoint(x,y)===c};
  })()`);
  assert.equal(
    point.canvas,
    true,
    "Empty virtual-pad space must pass through to the canvas",
  );
  const { x, y } = point;
  await screenshot("controls-before");
  await peer.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    buttons: 0,
  });
  await delay(100);
  await peer.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await delay(200);
  await peer.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await delay(1200);
  await screenshot("controls-mouse");

  await peer.evaluate("EJS_emulator.gameManager.loadState(testControlState)");
  await delay(500);
  assert.ok(
    await peer.evaluate(
      `document.elementFromPoint(${x},${y})===EJS_emulator.canvas`,
    ),
  );
  await peer.command("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1 }],
  });
  await delay(200);
  await peer.command("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await delay(1200);
  await screenshot("controls-touch");

  const buttons = await peer.evaluate(`(() => {
    window.testPadInputs=[];
    const e=EJS_emulator,send=e.gameManager.simulateInput.bind(e.gameManager);
    e.gameManager.simulateInput=(...args)=>{testPadInputs.push(args);return send(...args)};
    const point=selector=>{const el=e.virtualGamepad.querySelector(selector),r=el.getBoundingClientRect();
      const x=r.x+r.width/2,y=r.y+r.height/2;
      return {x,y,hit:el.contains(document.elementFromPoint(x,y))}};
    return {a:point('.b_a'),l:point('.b_l'),dpad:point('.ejs_dpad_main')};
  })()`);
  assert.ok(buttons.a.hit);
  assert.ok(buttons.l.hit);
  assert.ok(buttons.dpad.hit);
  await peer.command("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: buttons.a.x, y: buttons.a.y, id: 1 }],
  });
  await delay(100);
  await peer.command("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await peer.evaluate("EJS_emulator.gameManager.loadState(testControlState)");
  await delay(500);
  const heldButton = { x: buttons.l.x, y: buttons.l.y, id: 1 };
  await peer.command("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [heldButton],
  });
  await peer.command("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [heldButton, { x, y, id: 2 }],
  });
  const mixedStart = await peer.evaluate(
    "({events:testTouches.length,last:testTouches.at(-1)})",
  );
  await delay(200);
  await peer.command("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const mixedEnd = await peer.evaluate(
    "({events:testTouches.length,last:testTouches.at(-1)})",
  );
  await delay(1200);
  await screenshot("controls-touch-with-pad");

  await peer.command("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1 }],
  });
  await peer.command("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: x - 2, y: y - 2, id: 1 }],
  });
  await peer.command("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
  const result = await peer.evaluate(
    "({inputs:testPadInputs,touches:testTouches,locked:!!document.pointerLockElement})",
  );
  await writeFile(
    resolve(evidence, "controls.json"),
    JSON.stringify(
      { settings, point, buttons, mixedStart, mixedEnd, ...result },
      null,
      2,
    ),
  );
  assert.ok(
    result.inputs.some(
      ([port, button, pressed]) => port === 0 && button === 8 && pressed === 1,
    ),
  );
  assert.ok(
    result.inputs.some(
      ([port, button, pressed]) => port === 0 && button === 8 && pressed === 0,
    ),
  );
  assert.deepEqual(
    result.touches.map((event) => event.type),
    [
      "touchstart",
      "touchend",
      "touchstart",
      "touchend",
      "touchstart",
      "touchmove",
      "touchcancel",
    ],
  );
  assert.ok(
    result.touches.every(
      (event) => event.touches === event.targetTouches && event.touches <= 1,
    ),
  );
  assert.equal(result.locked, false);
}
