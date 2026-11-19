// Gyro aiming with a PS5 DualSense (WebHID, main thread).
//
// The Gamepad API has no motion data, so we read the controller's gyroscope over
// WebHID and feed look deltas into Module._SE1_PadLook(dx, dy) — the same entry
// point the gamepad right stick uses.
//
// URL params: gyro=0 (disable), gyrosens (default 1.5), gyroinvx=1, gyroinvy=1.
(function () {
  if (typeof window === 'undefined') return;

  var q = new URLSearchParams(location.search);
  if (q.get('gyro') === '0') return;
  if (!navigator.hid) return;

  var sens = parseFloat(q.get('gyrosens'));
  if (isNaN(sens) || sens <= 0) sens = 1.5;
  var invX = q.get('gyroinvx') === '1';
  var invY = q.get('gyroinvy') === '1';

  // COUNTS_PER_DEG: mouse counts per degree of view rotation at the default mouse sensitivity.
  // Measured in the game: _SE1_PadLook(100/200/400, 0) turns the view 25/50/100° (tools/gyrotest.mjs
  // step 1 checks it). A different in-game mouse sensitivity scales gyro the same way.
  var COUNTS_PER_DEG = 4;

  // DualSense report layout (dataView WITHOUT the report-id byte):
  //   USB:      reportId 0x01, gyro int16 LE at offsets 15/17/19, buttons at 9
  //   Bluetooth: reportId 0x31, same layout shifted +1 (16/18/20, buttons at 10)
  var USB_ID = 0x01, BT_ID = 0x31;
  var USB_GYRO = [15, 17, 19], USB_BTN = 9;
  var BT_GYRO = [16, 18, 20], BT_BTN = 10;

  var state = { connected: false, on: true, bias: [0, 0, 0], reports: 0, counts: [0, 0] };
  Module.se1Gyro = state;

  var device = null;
  var lastT = 0;
  var remainX = 0, remainY = 0;
  var quietSince = 0;   // timestamp when all axes last dropped below threshold
  var prevBtns = 0;

  // ---- UI: "Enable gyro" button + toast ----
  var btn = null;
  function showBtn() {
    if (btn || !document.body) return;
    btn = document.createElement('button');
    btn.textContent = 'Enable gyro';
    btn.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:10000;' +
      'background:rgba(0,0,0,0.75);color:#ccc;border:1px solid #555;border-radius:4px;' +
      'padding:4px 10px;font:12px sans-serif;cursor:pointer;';
    btn.addEventListener('click', function () {
      navigator.hid.requestDevice({ filters: [
        { vendorId: 0x054c, productId: 0x0ce6 },
        { vendorId: 0x054c, productId: 0x0df2 },
      ] }).then(function (devs) {
        if (devs.length) openDevice(devs[0]);
      }).catch(function () {});
    });
    document.body.appendChild(btn);
  }
  function hideBtn() {
    if (btn) { btn.remove(); btn = null; }
  }

  function toast(msg) {
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
      'background:rgba(0,0,0,0.7);color:#fff;padding:6px 14px;border-radius:4px;' +
      'font:14px sans-serif;z-index:9999;pointer-events:none;';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 1500);
  }

  // ---- device ----
  function openDevice(dev) {
    if (!dev.opened) dev.open().then(function () {
      // Bluetooth DualSense only starts sending 0x31 input reports after the
      // 0x05 feature report has been read once; USB works without it.
      dev.receiveFeatureReport(0x05).catch(function () {});   // a promise: USB may refuse it
      device = dev;
      state.connected = true;
      lastT = 0;
      quietSince = 0;
      dev.addEventListener('inputreport', onReport);
      hideBtn();
    }).catch(function () {});
  }

  // WebHID reports unplugging on navigator.hid, not on the device
  navigator.hid.addEventListener('disconnect', function (e) {
    if (!device || e.device !== device) return;
    device.removeEventListener('inputreport', onReport);
    device = null;
    state.connected = false;
    showBtn();
  });

  // ---- reports ----
  function onReport(e) {
    var d = e.data;
    var id = e.reportId;
    var gy, btnOff;
    if (id === USB_ID) {
      if (d.byteLength < 21) return;
      gy = USB_GYRO; btnOff = USB_BTN;
    } else if (id === BT_ID) {
      if (d.byteLength < 22) return;
      gy = BT_GYRO; btnOff = BT_BTN;
    } else return;

    var raw = [
      d.getInt16(gy[0], true),
      d.getInt16(gy[1], true),
      d.getInt16(gy[2], true),
    ];
    var btns = d.getUint8(btnOff);
    state.reports++;

    // touchpad click (bit 1) toggles gyro on/off, on the press only
    var tp = (btns & 0x02) !== 0;
    var prevTp = (prevBtns & 0x02) !== 0;
    if (tp && !prevTp) {
      state.on = !state.on;
      toast(state.on ? 'Gyro on' : 'Gyro off');
    }
    prevBtns = btns;

    // integrate
    var now = performance.now();
    var dt = lastT ? (now - lastT) / 1000 : 0;
    lastT = now;
    if (dt > 0.05) dt = 0.05;

    // raw → degrees/s
    var pitch = raw[0] / 16.384;
    var yaw = raw[1] / 16.384;
    var roll = raw[2] / 16.384;

    // drift: while all axes stay under 3 dps (after bias removal) for 0.5 s,
    // blend the raw values into the bias (2% per report)
    var pB = pitch - state.bias[0];
    var yB = yaw - state.bias[1];
    var rB = roll - state.bias[2];
    if (Math.abs(pB) < 3 && Math.abs(yB) < 3 && Math.abs(rB) < 3) {
      if (quietSince === 0) quietSince = now;
      if (now - quietSince > 500) {
        state.bias[0] += (pitch - state.bias[0]) * 0.02;
        state.bias[1] += (yaw - state.bias[1]) * 0.02;
        state.bias[2] += (roll - state.bias[2]) * 0.02;
      }
    } else {
      quietSince = 0;
    }

    // subtract bias
    pB = pitch - state.bias[0];
    yB = yaw - state.bias[1];

    // deadzone: rates under 0.5 dps count as 0
    if (Math.abs(pB) < 0.5) pB = 0;
    if (Math.abs(yB) < 0.5) yB = 0;

    // active only when the game wants the pointer and the tab is visible
    var active = state.on && document.visibilityState === 'visible';
    try { active = active && (Module['_SE1_WantPointer'] ? Module['_SE1_WantPointer']() : 0); } catch (ex) { active = 0; }
    if (!active || !dt) return;

    // degrees → counts; keep the fractional remainder so slow turns are not lost
    // positive raw yaw (controller turned left) → view LEFT → dx negative
    // positive raw pitch (front tilted up) → look UP → dy negative
    var degX = yB * sens * dt;
    var degY = pB * sens * dt;
    if (invX) degX = -degX;
    if (invY) degY = -degY;
    var cX = -degX * COUNTS_PER_DEG + remainX;
    var cY = -degY * COUNTS_PER_DEG + remainY;
    var dx = Math.round(cX);
    var dy = Math.round(cY);
    remainX = cX - dx;
    remainY = cY - dy;

    if (dx || dy) {
      state.counts[0] += dx;
      state.counts[1] += dy;
      try { if (Module._SE1_PadLook) Module._SE1_PadLook(dx, dy); } catch (ex) {}
    }
  }

  // ---- init: open an already-granted device, else wait for the gamepad ----
  navigator.hid.getDevices().then(function (devs) {
    for (var i = 0; i < devs.length; i++) {
      if (devs[i].vendorId === 0x054c &&
          (devs[i].productId === 0x0ce6 || devs[i].productId === 0x0df2)) {
        openDevice(devs[i]);
        return;
      }
    }
    // no granted device: show the button when a DualSense gamepad appears
    var onConn = function (e) {
      var p = e.gamepad;
      if (p && p.id && (p.id.indexOf('054c') !== -1 || p.id.indexOf('DualSense') !== -1)) {
        showBtn();
      }
    };
    window.addEventListener('gamepadconnected', onConn);
  }).catch(function () {});
})();
