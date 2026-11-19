// gl1shim command-stream replayer (render plan phase 1, notes/render-plan.md).
//
// port/common/gl1shim.c no longer calls WebGL. It records state changes and draws into a command
// buffer, with vertex/index data in two arenas, and SE1_GL1Shim_Flush() hands them over here: once
// per frame (before the swap), and before any call that needs WebGL right away (texture uploads,
// read-backs, queries). That's one wasm->JS crossing and two buffer uploads per frame instead of
// ~2000 crossings and ~390 uploads.
//
// JS owns every WebGL object; C refers to programs, uniform locations and textures by integer
// handles (index into the tables below; 0 = none). OPCODES MUST MATCH the OP_* enum in gl1shim.c.
Module['se1gfx'] = (function () {
  var gl = null, vao, vbuf, ibuf, qbuf, qcap = 0;
  var sb = [0, 0, 0, 0, 0, 0];   // this batch's vertex stream bases in vbuf (OP_VSTREAMS)
  // depth probes (OP_DEPTHPROBE): occlusion queries standing in for depth-buffer reads
  var probeProg = null, probeLoc = null, probePending = {}, probeFree = [], probeRes = 0;
  function probePoll() {   // finished queries -> the shim's result slots (shared memory)
    for (var slot in probePending) {
      var q = probePending[slot];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      HEAP32[(probeRes >> 2) + (+slot)] = gl.getQueryParameter(q, gl.QUERY_RESULT) ? 1 : 0;
      delete probePending[slot]; probeFree.push(q);
    }
  }
  function depthProbes(I, F, c, cnt) {
    if (!probeProg) {
      probeProg = gl.createProgram();
      var v = shader(gl.VERTEX_SHADER, '#version 300 es\nuniform vec3 uP;\nvoid main() { gl_Position = vec4(uP, 1.0); gl_PointSize = 1.0; }');
      var f = shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float;\nout vec4 o;\nvoid main() { o = vec4(0.0); }');
      gl.attachShader(probeProg, v); gl.attachShader(probeProg, f); gl.linkProgram(probeProg);
      probeLoc = gl.getUniformLocation(probeProg, 'uP');
    }
    // save the state the probes change
    var prog = gl.getParameter(gl.CURRENT_PROGRAM), vp = gl.getParameter(gl.VIEWPORT), dr = gl.getParameter(gl.DEPTH_RANGE);
    var df = gl.getParameter(gl.DEPTH_FUNC), dm = gl.getParameter(gl.DEPTH_WRITEMASK), cm = gl.getParameter(gl.COLOR_WRITEMASK);
    var dt = gl.isEnabled(gl.DEPTH_TEST), sc = gl.isEnabled(gl.SCISSOR_TEST);
    gl.useProgram(probeProg); gl.viewport(0, 0, backW, backH); gl.depthRange(0, 1);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(false); gl.colorMask(false, false, false, false);
    gl.disable(gl.SCISSOR_TEST);
    for (var k = 0; k < cnt; k++) {
      var o = c + 4 * k, slot = I[o];
      if (probePending[slot]) continue;          // the last query for this point is still in flight
      var q = probeFree.pop() || gl.createQuery();
      // visible if nothing nearer is in the depth buffer (DepthCheck.cpp: fOoK < buffer depth)
      gl.uniform3f(probeLoc, (I[o + 1] + 0.5) / logW * 2 - 1, (I[o + 2] + 0.5) / logH * 2 - 1, F[o + 3] * 2 - 1);
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, q);
      gl.drawArrays(gl.POINTS, 0, 1);
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      probePending[slot] = q;
    }
    gl.useProgram(prog); gl.viewport(vp[0], vp[1], vp[2], vp[3]); gl.depthRange(dr[0], dr[1]);
    gl.depthFunc(df); gl.depthMask(dm); gl.colorMask(cm[0], cm[1], cm[2], cm[3]);
    if (!dt) gl.disable(gl.DEPTH_TEST);
    if (sc) gl.enable(gl.SCISSOR_TEST);
  }
  // render scale (dynamic resolution): the engine keeps its logical size (SDL's canvas size, HUD
  // layout, input coordinates); we draw into a smaller backing store and scale viewport/scissor.
  // The page sets the canvas's CSS size, so the browser stretches the result to fill it.
  var logW = 0, logH = 0, backW = 0, backH = 0, sx = 1, sy = 1;
  function applyScale() {
    var c = Module['canvas'];
    if (c.width !== backW || c.height !== backH) { logW = c.width; logH = c.height; }  // SDL set a new mode
    var s = Math.min(1, Math.max(0.25, Module['se1Scale'] || 1));
    var bw = Math.max(1, Math.round(logW * s)), bh = Math.max(1, Math.round(logH * s));
    if (bw !== c.width || bh !== c.height) c.width = bw, c.height = bh;
    // the page (port/web/shell.html) sizes the canvas on screen from the logical size
    if (+c.dataset.logw !== logW || +c.dataset.logh !== logH) { c.dataset.logw = logW; c.dataset.logh = logH; }
    backW = bw; backH = bh; sx = bw / logW; sy = bh / logH;
  }
  function sxr(v) { return Math.round(v * sx); }
  function syr(v) { return Math.round(v * sy); }
  var progs = [null], ulocs = [null], texs = [null];

  function init() {
    if (gl) return;
    // single-threaded build: SDL's context. SE1_THREADS: the engine thread has no GL context,
    // so the main-thread replayer creates its own on the page canvas.
    gl = (typeof GL !== 'undefined' && GL.currentContext) ? GL.currentContext.GLctx
       : Module['canvas'].getContext('webgl2', { alpha: false, depth: true, stencil: true, antialias: false,
                                                 premultipliedAlpha: true, preserveDrawingBuffer: false });
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);                 // the only VAO, bound for good
    vbuf = gl.createBuffer(); ibuf = gl.createBuffer(); qbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);    // every attribute points into the vertex arena
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
    applyScale();
  }
  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('gl1shim shader error:', gl.getShaderInfoLog(s), src);
    return s;
  }

  return {
    backend: 'webgl2',
    get gl() { return gl; },   // the replayer's context (?glstats=1 in port/web/bench.js)
    createProgram: function (vs, fs, key) {   // key: used by the WebGPU replayer only
      init();
      var p = gl.createProgram(), v = shader(gl.VERTEX_SHADER, vs), f = shader(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
      gl.deleteShader(v); gl.deleteShader(f);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error('gl1shim link error:', gl.getProgramInfoLog(p));
      progs.push(p);
      return progs.length - 1;
    },
    uniformLocation: function (p, name) {
      var l = gl.getUniformLocation(progs[p], name);
      if (!l) return -1;
      ulocs.push(l);
      return ulocs.length - 1;
    },
    // handles are never reused: a deferred delete must not hit a newer texture
    // texture handles come from gl1shim (C); the object is created on first bind
    genTexture: function () { init(); texs.push(gl.createTexture()); return texs.length - 1; },   // (unused)
    // static index buffer turning quads (0,1,2,3) into triangles (0,1,2, 0,2,3)
    quadCapacity: function (ctQuads) {
      if (ctQuads <= qcap) return;
      init();
      var cap = 1024; while (cap < ctQuads) cap *= 2;
      var idx = new Uint32Array(cap * 6);
      for (var q = 0; q < cap; q++) {
        var b = q * 4, o = q * 6;
        idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2; idx[o + 3] = b; idx[o + 4] = b + 2; idx[o + 5] = b + 3;
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, qbuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
      qcap = cap;
    },
    // immediate calls (C flushed the stream first, so WebGL state matches the engine's view)
    texImage: function (sub, target, level, x, y, w, h, fmt, type, ptr, len) {
      init();
      var data = ptr ? HEAPU8.subarray(ptr, ptr + len) : null;
      if (sub) gl.texSubImage2D(target, level, x, y, w, h, fmt, type, data);
      else gl.texImage2D(target, level, gl.RGBA8, w, h, 0, fmt, type, data); // engine always sends RGBA8 pixels
    },
    readPixels: function (x, y, w, h, fmt, type, ptr, len) {
      init();
      if (sx === 1 && sy === 1) { gl.readPixels(x, y, w, h, fmt, type, HEAPU8.subarray(ptr, ptr + len)); return; }
      // logical-pixel request on a scaled backing store: read scaled, resample nearest (RGBA only)
      var rx = sxr(x), ry = syr(y), rw = Math.max(1, sxr(x + w) - rx), rh = Math.max(1, syr(y + h) - ry);
      var tmp = new Uint8Array(rw * rh * 4), out = HEAPU8.subarray(ptr, ptr + len);
      gl.readPixels(rx, ry, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
      for (var j = 0; j < h; j++) {
        var sj = Math.min(rh - 1, Math.floor(j * rh / h));
        for (var i = 0; i < w; i++) {
          var si = (sj * rw + Math.min(rw - 1, Math.floor(i * rw / w))) * 4, di = (j * w + i) * 4;
          out[di] = tmp[si]; out[di + 1] = tmp[si + 1]; out[di + 2] = tmp[si + 2]; out[di + 3] = tmp[si + 3];
        }
      }
    },
    // called once per frame after the swap flush: resolution changes take effect next frame
    endFrame: function () { if (gl) applyScale(); },
    pixelStore: function (p, v) { init(); gl.pixelStorei(p, v); },
    hasAnisotropy: function () { init(); return !!gl.getExtension('EXT_texture_filter_anisotropic'); },
    sync: function () { if (gl) gl.finish(); return null; },
    // visual regression capture: bottom-up RGBA, delivered to cb (synchronously here)
    capture: function (cb) {
      init();
      var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      cb(px, w, h);
    },
    getParam: function (pname, ptr, isFloat) {
      init();
      var v = gl.getParameter(pname), H = isFloat ? HEAPF32 : HEAP32, o = ptr >> 2;
      if (v === null || v === undefined) { H[o] = 0; return 0; }
      if (typeof v === 'number' || typeof v === 'boolean') { H[o] = +v; return 1; }
      if (v.length !== undefined) { for (var i = 0; i < v.length; i++) H[o + i] = +v[i]; return v.length; }
      H[o] = 0; return 0;
    },

    replay: function (cp, n, vp, vn, ip, inn, dp, dn) {
      init();
      var I = HEAP32, F = HEAPF32, c = cp >> 2, end = c + n;
      if (probeRes) probePoll();
      if (vn) gl.bufferData(gl.ARRAY_BUFFER, HEAPU8.subarray(vp, vp + vn), gl.STREAM_DRAW);
      if (inn) gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, HEAPU8.subarray(ip, ip + inn), gl.STREAM_DRAW);
      while (c < end) {
        switch (I[c]) {
        case 1:  gl.enable(I[c + 1]); c += 2; break;                                   // ENABLE cap
        case 2:  gl.disable(I[c + 1]); c += 2; break;                                  // DISABLE cap
        case 3:  gl.blendFunc(I[c + 1], I[c + 2]); c += 3; break;                       // BLENDFUNC s d
        case 4:  gl.depthFunc(I[c + 1]); c += 2; break;                                // DEPTHFUNC f
        case 5:  gl.depthMask(!!I[c + 1]); c += 2; break;                              // DEPTHMASK b
        case 6:  gl.colorMask(!!I[c + 1], !!I[c + 2], !!I[c + 3], !!I[c + 4]); c += 5; break;
        case 7:  gl.cullFace(I[c + 1]); c += 2; break;                                 // CULLFACE m
        case 8:  gl.frontFace(I[c + 1]); c += 2; break;                                // FRONTFACE m
        case 9:  gl.polygonOffset(F[c + 1], F[c + 2]); c += 3; break;                  // POLYOFFSET f u
        case 10: var vx = sxr(I[c + 1]), vy = syr(I[c + 2]);                     // VIEWPORT (scaled)
                 gl.viewport(vx, vy, sxr(I[c + 1] + I[c + 3]) - vx, syr(I[c + 2] + I[c + 4]) - vy); c += 5; break;
        case 11: var qx = sxr(I[c + 1]), qy = syr(I[c + 2]);                     // SCISSOR (scaled)
                 gl.scissor(qx, qy, sxr(I[c + 1] + I[c + 3]) - qx, syr(I[c + 2] + I[c + 4]) - qy); c += 5; break;
        case 12: gl.clearColor(F[c + 1], F[c + 2], F[c + 3], F[c + 4]); c += 5; break;
        case 13: gl.clearDepth(F[c + 1]); c += 2; break;
        case 14: gl.clearStencil(I[c + 1]); c += 2; break;
        case 15: gl.clear(I[c + 1]); c += 2; break;
        case 16: gl.depthRange(F[c + 1], F[c + 2]); c += 3; break;
        case 17: gl.activeTexture(I[c + 1]); c += 2; break;                            // ACTIVETEX enum
        case 18: { var th = I[c + 2];                                                   // BINDTEX target handle
          if (th && !texs[th]) texs[th] = gl.createTexture();                             // first use of a handle
          gl.bindTexture(I[c + 1], th ? texs[th] : null); c += 3; break; }
        case 19: gl.texParameteri(I[c + 1], I[c + 2], I[c + 3]); c += 4; break;
        case 20: gl.texParameterf(I[c + 1], I[c + 2], F[c + 3]); c += 4; break;
        case 21: if (texs[I[c + 1]]) gl.deleteTexture(texs[I[c + 1]]); texs[I[c + 1]] = null; c += 2; break;
        case 22: gl.useProgram(progs[I[c + 1]] || null); c += 2; break;
        case 23: gl.uniform1i(ulocs[I[c + 1]], I[c + 2]); c += 3; break;
        case 24: gl.uniform1f(ulocs[I[c + 1]], F[c + 2]); c += 3; break;
        case 25: gl.uniform4f(ulocs[I[c + 1]], F[c + 2], F[c + 3], F[c + 4], F[c + 5]); c += 6; break;
        case 26: gl.uniformMatrix4fv(ulocs[I[c + 1]], false, F.subarray(c + 2, c + 18)); c += 18; break;
        case 27: gl.enableVertexAttribArray(I[c + 1]); c += 2; break;
        case 28: gl.disableVertexAttribArray(I[c + 1]); c += 2; break;
        case 29: gl.vertexAttrib4f(I[c + 1], F[c + 2], F[c + 3], F[c + 4], F[c + 5]); c += 6; break;
        case 30: gl.vertexAttribPointer(I[c + 1], I[c + 2], I[c + 3], !!I[c + 4], I[c + 5], sb[I[c + 1]] + I[c + 6]); c += 7; break;
        case 31: gl.drawElements(I[c + 1], I[c + 2], I[c + 3], I[c + 4]); c += 5; break; // mode count type off
        case 32:                                                                        // DRAW_QUADS count off
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, qbuf);
          gl.drawElements(gl.TRIANGLES, I[c + 1], gl.UNSIGNED_INT, I[c + 2]);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
          c += 3; break;
        case 33: gl.drawArrays(I[c + 1], I[c + 2], I[c + 3]); c += 4; break;           // mode first count
        case 34:                                                                        // TEXIMAGE (data in the data arena)
          this.texImage(I[c + 1], I[c + 2], I[c + 3], I[c + 4], I[c + 5], I[c + 6], I[c + 7], I[c + 8], I[c + 9],
                        I[c + 10] >= 0 ? dp + I[c + 10] : 0, I[c + 11]);
          c += 12; break;
        case 35: gl.pixelStorei(I[c + 1], I[c + 2]); c += 3; break;                    // PIXELSTORE
        case 37:                                                                        // DEPTHPROBE n res (slot x y depth) x n
          probeRes = I[c + 2]; depthProbes(I, F, c + 3, I[c + 1]); c += 3 + 4 * I[c + 1]; break;
        case 36: {                                                                      // VSTREAMS (ptr len) x6
          var tot = 0, k;
          for (k = 0; k < 6; k++) { sb[k] = tot; tot += (I[c + 2 + 2 * k] + 15) & ~15; }
          if (tot) {
            gl.bufferData(gl.ARRAY_BUFFER, tot, gl.STREAM_DRAW);
            for (k = 0; k < 6; k++) {
              var sp = I[c + 1 + 2 * k] >>> 0, sn = I[c + 2 + 2 * k];
              if (sn) gl.bufferSubData(gl.ARRAY_BUFFER, sb[k], HEAPU8.subarray(sp, sp + sn));
            }
          }
          c += 13; break;
        }
        default:
          console.error('gl1shim replay: bad opcode ' + I[c] + ' at word ' + (c - (cp >> 2)));
          return;
        }
      }
    }
  };
})();
