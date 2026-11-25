// gl1shim command-stream replayer (render plan phase 1, notes/render-plan.md).
//
// port/common/gl1shim.c no longer calls WebGL. It records state changes and draws into a command
// buffer, with vertex/index data in two arenas, and SE1_GL1Shim_Flush() hands them over here: once
// per frame (before the swap), and before any call that needs WebGL right away (texture uploads,
// read-backs, queries). That's one wasm->JS crossing and two buffer uploads per frame instead of
// ~2000 crossings and ~390 uploads.
//
// handles (index into the tables below; 0 = none). OPCODES MUST MATCH the OP_* enum in gl1shim.c.
// Module.se1GfxSync counts the synchronous main-thread calls (incremented here, on the main
// thread) so a threaded build can prove the hot path stopped calling into it.
Module['se1gfx'] = (function () {
  var sync = { createProgram: 0, uniformLocation: 0, other: 0 };   // Module.se1GfxSync
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
    postResize(bw, bh);
  }
  function sxr(v) { return Math.round(v * sx); }
  function syr(v) { return Math.round(v * sy); }
  // ---- post-processing (?post=hq or a list: bloom,grade,fxaa,sharpen,aniso,trilinear) ----
  // The frame renders into an offscreen FBO. gl1shim records OP_WORLDEND at the last
  // perspective->ortho switch of a frame (after the world, lens flares and the weapon, before the
  // HUD); there the world chain runs (bloom -> composite/grade -> fxaa -> sharpen, ping-ponging
  // between two textures) and the HUD draws on top of its result. endFrame blits that to the canvas.
  // Frames without a world (menus) get no effects.
  // Bloom source: a second colour attachment ("emissive") that additive draws (explosions, flares,
  // projectiles, lasers, specular passes) write their colour into, opaque and alpha-blended draws
  // occlude (they write 0 with the frame's blend state), and multiplicative passes (shadow maps,
  // detail textures) leave alone (draw buffer 1 off). Plus a soft threshold on the scene itself.
  // Everything is created once (and again on resize); per-frame work is binds and draws.
  var postFx = [], postSharp = 0.5, postOn = false;
  var postBloom = false, postGrade = false, postAniso = 0, postTrilinear = false;
  // live-tunable (Module.se1Post.params): bloom strength, emissive gain, threshold, saturation,
  // contrast, vignette, highlight knee
  var PP = { bloom: 1.0, emis: 1.0, thr: 0.93, thrK: 0.12, sat: 1.12, con: 1.05, vig: 0.22, knee: 0.75, bw1: 0.6, bw2: 0.8 };
  var pf = { open: false, split: false, mrt: false, db: -1, out: 0 };   // this frame
  var blendOn = false, bSrc = 1, bDst = 0;   // tracked from the stream (emissive mode per draw)
  var postTex = [null, null], postFbo = [null, null], postDepth = null, emisTex = null;
  var blTex = [], blFbo = [];                 // bloom: 0,1 half size; 2,3 quarter size
  var postVao = null, postVbo = null, PR = {};
  var postTexW = 0, postTexH = 0, blW = [0, 0], blH = [0, 0];
  var Z4 = new Float32Array(4), DB2 = null, DB1 = null;
  var POST_VS = '#version 300 es\n' +
    'in vec2 aP;\nout vec2 vP;\n' +
    'void main() { vP = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }';
  var FS_HEAD = '#version 300 es\nprecision highp float;\nin vec2 vP; out vec4 o;\n';
  var FXAA_FS = FS_HEAD +
    'uniform sampler2D t; uniform vec2 uTexel;\n' +
    '// FXAA (Lottes\' compact PC version, as used in many WebGL demos)\n' +
    'void main() {\n' +
    '  vec3 rgbNW = texture(t, vP + vec2(-1.0, -1.0) * uTexel).rgb;\n' +
    '  vec3 rgbNE = texture(t, vP + vec2( 1.0, -1.0) * uTexel).rgb;\n' +
    '  vec3 rgbSW = texture(t, vP + vec2(-1.0,  1.0) * uTexel).rgb;\n' +
    '  vec3 rgbSE = texture(t, vP + vec2( 1.0,  1.0) * uTexel).rgb;\n' +
    '  vec4 texM = texture(t, vP); vec3 rgbM = texM.rgb;\n' +
    '  vec3 luma = vec3(0.299, 0.587, 0.114);\n' +
    '  float lumaNW = dot(rgbNW, luma), lumaNE = dot(rgbNE, luma), lumaSW = dot(rgbSW, luma), lumaSE = dot(rgbSE, luma), lumaM = dot(rgbM, luma);\n' +
    '  float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));\n' +
    '  float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));\n' +
    '  vec2 dir = vec2(-((lumaNW + lumaNE) - (lumaSW + lumaSE)), (lumaNW + lumaSW) - (lumaNE + lumaSE));\n' +
    '  float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * (0.25 * (1.0 / 8.0)), 1.0 / 128.0);\n' +
    '  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);\n' +
    '  dir = min(vec2(8.0), max(vec2(-8.0), dir * rcpDirMin)) * uTexel;\n' +
    '  vec3 rgbA = 0.5 * (texture(t, vP + dir * (1.0 / 3.0 - 0.5)).rgb + texture(t, vP + dir * (2.0 / 3.0 - 0.5)).rgb);\n' +
    '  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture(t, vP + dir * -0.5).rgb + texture(t, vP + dir * 0.5).rgb);\n' +
    '  float lumaB = dot(rgbB, luma);\n' +
    '  o = vec4((lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB, 1.0);\n' +
    '}';
  var SHARPEN_FS = FS_HEAD +
    'uniform sampler2D t; uniform vec2 uTexel; uniform float uS;\n' +
    '// simple contrast-adaptive sharpen on all three channels\n' +
    'void main() {\n' +
    '  vec3 c = texture(t, vP).rgb;\n' +
    '  vec3 n = texture(t, vP + vec2(0.0, -uTexel.y)).rgb, s = texture(t, vP + vec2(0.0, uTexel.y)).rgb;\n' +
    '  vec3 w = texture(t, vP + vec2(-uTexel.x, 0.0)).rgb, e = texture(t, vP + vec2(uTexel.x, 0.0)).rgb;\n' +
    '  vec3 mn = min(c, min(min(n, s), min(w, e))), mx = max(c, max(max(n, s), max(w, e)));\n' +
    '  float amount = uS * clamp(1.0 - (max(mx.r, max(mx.g, mx.b)) - min(mn.r, min(mn.g, mn.b))), 0.0, 1.0);\n' +
    '  o = vec4(clamp(c + (4.0 * c - n - s - w - e) * amount * 0.25, 0.0, 1.0), 1.0);\n' +
    '}';
  var BLIT_FS = FS_HEAD + 'uniform sampler2D t;\nvoid main() { o = texture(t, vP); }';
  // bloom source at half size: emissive + the scene above a soft threshold, 4 bilinear taps (4x4 box)
  var BRIGHT_FS = FS_HEAD +
    'uniform sampler2D t; uniform sampler2D te; uniform vec2 uTexel; uniform vec4 uK;\n' +   // emis, thr, thrK
    'vec3 f(vec2 uv) { vec3 s = texture(t, uv).rgb; float l = max(s.r, max(s.g, s.b));\n' +
    '  return texture(te, uv).rgb * uK.x + s * smoothstep(uK.y, 1.0, l) * uK.z; }\n' +
    'void main() { o = vec4(0.25 * (f(vP + vec2(-1.0, -1.0) * uTexel) + f(vP + vec2(1.0, -1.0) * uTexel) +\n' +
    '  f(vP + vec2(-1.0, 1.0) * uTexel) + f(vP + vec2(1.0, 1.0) * uTexel)), 1.0); }';
  var DOWN_FS = FS_HEAD +
    'uniform sampler2D t; uniform vec2 uTexel;\n' +
    'void main() { o = 0.25 * (texture(t, vP + vec2(-1.0, -1.0) * uTexel) + texture(t, vP + vec2(1.0, -1.0) * uTexel) +\n' +
    '  texture(t, vP + vec2(-1.0, 1.0) * uTexel) + texture(t, vP + vec2(1.0, 1.0) * uTexel)); }';
  // 9-tap gaussian in 5 bilinear fetches; uTexel carries the direction
  var BLUR_FS = FS_HEAD +
    'uniform sampler2D t; uniform vec2 uTexel;\n' +
    'void main() { vec3 c = texture(t, vP).rgb * 0.2270270;\n' +
    '  c += (texture(t, vP + uTexel * 1.3846154).rgb + texture(t, vP - uTexel * 1.3846154).rgb) * 0.3162162;\n' +
    '  c += (texture(t, vP + uTexel * 3.2307692).rgb + texture(t, vP - uTexel * 3.2307692).rgb) * 0.0702703;\n' +
    '  o = vec4(c, 1.0); }';
  // scene + bloom, then (grade) a highlight shoulder instead of a hard clip, saturation, contrast
  // and a vignette. Below the knee the image is untouched apart from saturation/contrast.
  var COMP_FS = FS_HEAD +
    'uniform sampler2D t; uniform sampler2D b1; uniform sampler2D b2; uniform vec2 uBW; uniform vec4 uG; uniform float uKnee;\n' +   // uG: on, sat, con, vig
    'void main() { vec3 c = texture(t, vP).rgb + texture(b1, vP).rgb * uBW.x + texture(b2, vP).rgb * uBW.y;\n' +
    '  if (uG.x > 0.5) {\n' +
    '    vec3 k = vec3(uKnee), r = 1.0 - k;\n' +
    '    c = mix(c, k + r * (1.0 - exp(-(c - k) / r)), step(k, c));\n' +
    '    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));\n' +
    '    c = max(mix(vec3(l), c, uG.y), 0.0);\n' +
    '    c = (c - 0.5) * uG.z + 0.5;\n' +
    '    vec2 d = vP - 0.5; c *= 1.0 - uG.w * dot(d, d) * 2.0;\n' +
    '  }\n' +
    '  o = vec4(clamp(c, 0.0, 1.0), 1.0); }';
  function postTex2D(w, h) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);   // the passes sample between texels
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  // (re)create every size-dependent target; leaves the texture/renderbuffer/framebuffer bindings
  // to the caller (postMake and postResize restore them)
  function postAlloc(w, h) {
    var i;
    for (i = 0; i < 2; i++) if (postTex[i]) gl.deleteTexture(postTex[i]);
    for (i = 0; i < blTex.length; i++) gl.deleteTexture(blTex[i]);
    if (emisTex) gl.deleteTexture(emisTex);
    if (!postDepth) postDepth = gl.createRenderbuffer();
    for (i = 0; i < 2; i++) if (!postFbo[i]) postFbo[i] = gl.createFramebuffer();
    postTexW = w; postTexH = h;
    postTex[0] = postTex2D(w, h); postTex[1] = postTex2D(w, h);
    emisTex = postBloom ? postTex2D(w, h) : null;
    gl.bindRenderbuffer(gl.RENDERBUFFER, postDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    for (i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, postFbo[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, postTex[i], 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, postDepth);
      if (i === 0 && emisTex) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, emisTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
    }
    blTex = []; blW = [Math.max(1, w >> 1), Math.max(1, w >> 2)]; blH = [Math.max(1, h >> 1), Math.max(1, h >> 2)];
    if (postBloom) {
      for (i = 0; i < 4; i++) {
        blTex[i] = postTex2D(blW[i >> 1], blH[i >> 1]);
        if (!blFbo[i]) blFbo[i] = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, blFbo[i]);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, blTex[i], 0);
      }
    }
    pf.db = -1;   // postFbo[0]'s draw buffers: set again when the next frame opens
    return true;
  }
  function postMake() {   // one-time setup; called from init() after the size is known
    if (postOn) return;
    // leave the replayer's bindings as they were (its vertex arena must stay on ARRAY_BUFFER)
    var keep = { vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING), ab: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
                 tex: gl.getParameter(gl.TEXTURE_BINDING_2D) };
    postMakeInner();
    gl.bindVertexArray(keep.vao); gl.bindBuffer(gl.ARRAY_BUFFER, keep.ab); gl.bindTexture(gl.TEXTURE_2D, keep.tex);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function postMakeInner() {
    DB2 = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]; DB1 = [gl.COLOR_ATTACHMENT0, gl.NONE];
    if (!postAlloc(gl.drawingBufferWidth, gl.drawingBufferHeight)) {
      console.error('se1gfx: post framebuffer incomplete (' + gl.checkFramebufferStatus(gl.FRAMEBUFFER) + '), post disabled');
      postOn = false; return;
    }
    postVao = gl.createVertexArray();
    postVbo = gl.createBuffer();
    gl.bindVertexArray(postVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, postVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    var mk = function (name, fs, names) {
      var p = gl.createProgram(), v = shader(gl.VERTEX_SHADER, POST_VS), f = shader(gl.FRAGMENT_SHADER, fs);
      if (!gl.getShaderParameter(v, gl.COMPILE_STATUS) || !gl.getShaderParameter(f, gl.COMPILE_STATUS)) {
        console.error('se1gfx post shader compile error (' + name + '):', gl.getShaderInfoLog(v), gl.getShaderInfoLog(f));
        gl.deleteShader(v); gl.deleteShader(f); gl.deleteProgram(p); return false;
      }
      gl.attachShader(p, v); gl.attachShader(p, f);
      gl.bindAttribLocation(p, 0, 'aP');
      gl.linkProgram(p);
      gl.deleteShader(v); gl.deleteShader(f);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error('se1gfx post shader link error (' + name + '):', gl.getProgramInfoLog(p));
        gl.deleteProgram(p); return false;
      }
      var L = { p: p };
      ('t uTexel ' + (names || '')).split(' ').forEach(function (n) { if (n) L[n] = gl.getUniformLocation(p, n); });
      gl.useProgram(p);   // samplers: unit order t, te|b1, b2
      if (L.te) gl.uniform1i(L.te, 1);
      if (L.b1) gl.uniform1i(L.b1, 1);
      if (L.b2) gl.uniform1i(L.b2, 2);
      gl.useProgram(null);
      PR[name] = L;
      return true;
    };
    var ok = mk('blit', BLIT_FS);
    if (postFx.indexOf('fxaa') >= 0) ok = mk('fxaa', FXAA_FS) && ok;
    if (postFx.indexOf('sharpen') >= 0) ok = mk('sharpen', SHARPEN_FS, 'uS') && ok;
    if (postBloom) ok = mk('bright', BRIGHT_FS, 'te uK') && mk('down', DOWN_FS) && mk('blur', BLUR_FS) && ok;
    if (postBloom || postGrade) ok = mk('comp', COMP_FS, 'b1 b2 uBW uG uKnee') && ok;
    if (!ok) { console.error('se1gfx: a post program failed, post disabled'); postOn = false; return; }
    postOn = true;
  }
  function postResize(w, h) {   // called from applyScale when the backing store changes
    if (!postOn) return;
    if (w === postTexW && h === postTexH) return;
    var tex = gl.getParameter(gl.TEXTURE_BINDING_2D);   // the engine's texture on the active unit
    var fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    if (!postAlloc(w, h)) { console.error('se1gfx: post framebuffer incomplete after resize, post disabled'); postOn = false; }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, postOn ? fb : null);
  }
  // the state the post passes change; the C shim records state only when it changes, so the
  // replayer's GL state must be exactly as it was afterwards
  function postSave() {
    var s = {
      blend: gl.isEnabled(gl.BLEND), depth: gl.isEnabled(gl.DEPTH_TEST), cull: gl.isEnabled(gl.CULL_FACE),
      scissor: gl.isEnabled(gl.SCISSOR_TEST), stencil: gl.isEnabled(gl.STENCIL_TEST),
      vp: gl.getParameter(gl.VIEWPORT), cm: gl.getParameter(gl.COLOR_WRITEMASK),
      prog: gl.getParameter(gl.CURRENT_PROGRAM), unit: gl.getParameter(gl.ACTIVE_TEXTURE),
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING), ab: gl.getParameter(gl.ARRAY_BUFFER_BINDING), tex: []
    };
    for (var u = 0; u < 3; u++) { gl.activeTexture(gl.TEXTURE0 + u); s.tex[u] = gl.getParameter(gl.TEXTURE_BINDING_2D); }
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(postVao);
    return s;
  }
  function postRestore(s) {
    gl.bindVertexArray(s.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.ab);
    for (var u = 2; u >= 0; u--) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, s.tex[u]); }
    gl.activeTexture(s.unit);
    gl.useProgram(s.prog);
    gl.colorMask(s.cm[0], s.cm[1], s.cm[2], s.cm[3]);
    gl.viewport(s.vp[0], s.vp[1], s.vp[2], s.vp[3]);
    if (s.blend) gl.enable(gl.BLEND);
    if (s.depth) gl.enable(gl.DEPTH_TEST);
    if (s.cull) gl.enable(gl.CULL_FACE);
    if (s.scissor) gl.enable(gl.SCISSOR_TEST);
    if (s.stencil) gl.enable(gl.STENCIL_TEST);
  }
  function pass(L, fbo, w, h, t0, t1, t2) {   // one fullscreen triangle
    gl.useProgram(L.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    if (t2) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, t2); }
    if (t1) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t1); }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // a frame's first replay: render into the scene FBO; clear the emissive target
  function postOpen() {
    pf.open = true; pf.split = false; pf.out = 0; pf.mrt = !!emisTex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, postFbo[0]);
    if (pf.mrt) {
      gl.drawBuffers(DB2); pf.db = 1;
      var sc = gl.isEnabled(gl.SCISSOR_TEST), cm = gl.getParameter(gl.COLOR_WRITEMASK);
      if (sc) gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.clearBufferfv(gl.COLOR, 1, Z4);
      gl.colorMask(cm[0], cm[1], cm[2], cm[3]);
      if (sc) gl.enable(gl.SCISSOR_TEST);
    }
  }
  // per draw while the emissive target is live: pick its draw buffers and the program's uEmis
  function emisPrep(p) {
    var m = !blendOn ? 0 : bDst === 1 ? 1                                        // additive (x, ONE)
          : ((bSrc === 0x0306 || bSrc === 0) && (bDst === 0x0300 || bDst === 0)) ? 2 : 0;   // multiplicative
    var db = m === 2 ? 0 : 1;
    if (db !== pf.db) { gl.drawBuffers(db ? DB2 : DB1); pf.db = db; }
    var e = p && p.se1Emis;
    if (e && e.v !== (m === 1 ? 1 : 0)) { e.v = m === 1 ? 1 : 0; gl.uniform1f(e.loc, e.v); }
  }
  // OP_WORLDEND: the world is done; run the world chain, then let the HUD draw over the result
  function postWorld() {
    if (!pf.open || pf.split) return;
    var t0 = performance.now(), s = postSave(), from = 0, w = postTexW, h = postTexH;
    if (pf.mrt) { gl.drawBuffers(DB1); pf.db = 0; }   // done with the emissive target this frame
    pf.mrt = false;
    if (postBloom) {
      var L = PR.bright;
      gl.useProgram(L.p);
      gl.uniform2f(L.uTexel, 1 / w, 1 / h);
      gl.uniform4f(L.uK, PP.emis, PP.thr, PP.thrK, 0);
      pass(L, blFbo[0], blW[0], blH[0], postTex[0], emisTex);
      L = PR.blur; gl.useProgram(L.p);
      gl.uniform2f(L.uTexel, 1 / blW[0], 0); pass(L, blFbo[1], blW[0], blH[0], blTex[0]);
      gl.uniform2f(L.uTexel, 0, 1 / blH[0]); pass(L, blFbo[0], blW[0], blH[0], blTex[1]);
      L = PR.down; gl.useProgram(L.p);
      gl.uniform2f(L.uTexel, 0.5 / blW[0], 0.5 / blH[0]); pass(L, blFbo[2], blW[1], blH[1], blTex[0]);
      L = PR.blur; gl.useProgram(L.p);
      gl.uniform2f(L.uTexel, 1 / blW[1], 0); pass(L, blFbo[3], blW[1], blH[1], blTex[2]);
      gl.uniform2f(L.uTexel, 0, 1 / blH[1]); pass(L, blFbo[2], blW[1], blH[1], blTex[3]);
    }
    if (PR.comp) {
      var C = PR.comp;
      gl.useProgram(C.p);
      gl.uniform2f(C.uBW, postBloom ? PP.bw1 * PP.bloom : 0, postBloom ? PP.bw2 * PP.bloom : 0);
      gl.uniform4f(C.uG, postGrade ? 1 : 0, PP.sat, PP.con, PP.vig);
      gl.uniform1f(C.uKnee, PP.knee);
      pass(C, postFbo[1], w, h, postTex[0], postBloom ? blTex[0] : postTex[0], postBloom ? blTex[2] : postTex[0]);
      from = 1;
    }
    for (var i = 0; i < postFx.length; i++) {
      var X = PR[postFx[i]];
      if (!X || (postFx[i] !== 'fxaa' && postFx[i] !== 'sharpen')) continue;
      gl.useProgram(X.p);
      gl.uniform2f(X.uTexel, 1 / w, 1 / h);
      if (X.uS) gl.uniform1f(X.uS, postSharp);
      pass(X, postFbo[from ^ 1], w, h, postTex[from]);
      from ^= 1;
    }
    pf.split = true; pf.out = from;
    postRestore(s);
    gl.bindFramebuffer(gl.FRAMEBUFFER, postFbo[from]);   // the HUD draws over the result
    Module.se1Post.worldMs = performance.now() - t0;
  }
  function postRun() {   // end of frame: blit the frame's result to the canvas
    if (!pf.open) return;
    pf.open = false;
    if (!postOn) return;
    var t0 = performance.now(), s = postSave();
    pass(PR.blit, null, backW, backH, postTex[pf.out]);
    postRestore(s);
    Module.se1Post.ms = performance.now() - t0 + (pf.split ? Module.se1Post.worldMs : 0);
    Module.se1Post.frames++;
    if (pf.split) Module.se1Post.worldFrames++;
  }
  var progs = [null], ulocs = [null], texs = [null];
  // threaded build: program handles are allocated by the worker (OP_NEWPROG); the WebGL object is
  // created here on first use. A failed program stays null: useProgram(null) is a no-op, its
  // uniform locations resolve to -1, and the uniform sets no-op, so it can't crash the replay.
  function buildProgram(h, key, vs, fs) {
    // bloom: the engine's shaders (and GpuAnim's) also write the emissive target, location 1:
    // their colour when uEmis is 1 (additive draws), else 0 (occluders; see emisPrep)
    var emis = postBloom && /out vec4 \w+;/.test(fs) && /\s(\w+) = c; \}\s*$/.test(fs);
    if (emis) fs = fs.replace(/out vec4 (\w+);/, 'layout(location=0) out vec4 $1; layout(location=1) out vec4 oEmis; uniform float uEmis;')
                     .replace(/(\s)(\w+) = c; \}\s*$/, '$1$2 = c; oEmis = uEmis > 0.5 ? c : vec4(0.0, 0.0, 0.0, c.a); }\n');
    var p = gl.createProgram(), v = shader(gl.VERTEX_SHADER, vs), f = shader(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    gl.deleteShader(v); gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('gl1shim link error (program ' + h + ', key ' + key + '):', gl.getProgramInfoLog(p));
      gl.deleteProgram(p);
      return null;
    }
    if (emis) { var el = gl.getUniformLocation(p, 'uEmis'); if (el) p.se1Emis = { loc: el, v: 0 }; }
    return p;
  }

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
    var po = Module['se1PostOpts'];
    if (po) {
      var list = [];
      po.effects.forEach(function (e) {
        if (e === 'hq') list.push('bloom', 'grade', 'fxaa', 'sharpen', 'aniso', 'trilinear'); else list.push(e);
      });
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e === 'bloom') postBloom = true;
        else if (e === 'grade') postGrade = true;
        else if (e === 'trilinear') postTrilinear = true;
        else if (/^aniso\d*$/.test(e)) {
          var ax = gl.getExtension('EXT_texture_filter_anisotropic');
          if (ax) postAniso = Math.min(+e.slice(5) || 16, gl.getParameter(ax.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
        } else if (e !== 'fxaa' && e !== 'sharpen') { console.warn('se1gfx: unknown post effect "' + e + '" ignored'); continue; }
        if (postFx.indexOf(e) < 0) postFx.push(e);
      }
      postSharp = po.sharp;
      if (po.bloom !== undefined) PP.bloom = po.bloom;
      (po.pp || '').split(',').forEach(function (kv) {
        var m = kv.split(':');
        if (m.length === 2 && PP.hasOwnProperty(m[0]) && !isNaN(+m[1])) PP[m[0]] = +m[1];
      });
    }
    Module.se1Post = { effects: postFx, ms: 0, worldMs: 0, frames: 0, worldFrames: 0, params: PP, aniso: postAniso,
                       get on() { return postOn; } };
    applyScale();
    if (postBloom || postGrade || postFx.indexOf('fxaa') >= 0 || postFx.indexOf('sharpen') >= 0) postMake();
  }
  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('gl1shim shader error:', gl.getShaderInfoLog(s), src);
    return s;
  }

  // TextDecoder can't read SharedArrayBuffer (threaded build): copy the bytes first.
  // len includes the trailing NUL from src_str; decode len-1 bytes so the string is clean.
  function utf8(H, off, len) {
    var b = new Uint8Array(len - 1);
    b.set(H.subarray(off, off + len - 1));
    return new TextDecoder().decode(b);
  }


  // ---- GPU model animation (OP_GA_*, port/common/GpuAnim.cpp, ?gpuanim) ----
  // Model frames are uploaded once (RGBA16I texture: x, y, z, normal code per model vertex per
  // frame); per mip a static mesh (model vertex + surface index + texcoord per surface vertex,
  // u32 elements); per frame only instance records (frame bases, lerp ratio, colour mask,
  // modelview, stretch, model colour, light) and one instanced draw per model/texture. The vertex
  // shader does the unpack, lerp and the integer shading of RenderModel_View.cpp's UnpackFrame /
  // ShadesToColors / diffuse colour setup. The draw keeps the shim's GL state: its own program
  // and VAO, the texture units 6/7 the shim never uses, then back to the replayer's bindings.
  var GA_REC = 112;        // bytes per instance record (7 x uvec4), GpuAnim.cpp GARecord
  var GA_MAXSRF = 64;
  var gaProg = null, gaU = null, gaIbuf = null, gaNorm = null, gaFrames = [], gaMeshes = [];
  var gaInstKey = -1, curProg = null, curUnit = 0x84C0;
  var gaStats = { draws: 0, inst: 0, meshes: 0, frames: 0 };   // ?gpuanim counters (se1gfx.gaStats)
  var GA_VS = '#version 300 es\n' +
    'precision highp float; precision highp int; precision highp isampler2D;\n' +
    'layout(location=0) in uvec4 aV;\n' +
    'layout(location=1) in uvec4 i0; layout(location=2) in uvec4 i1; layout(location=3) in uvec4 i2;\n' +
    'layout(location=4) in uvec4 i3; layout(location=5) in uvec4 i4; layout(location=6) in uvec4 i5;\n' +
    'layout(location=7) in uvec4 i6;\n' +
    'uniform isampler2D uFrames; uniform sampler2D uNorm; uniform mat4 uProj; uniform vec3 uOffset;\n' +
    'uniform vec2 uTexCorr; uniform int uFW; uniform uint uFlags; uniform uvec4 uSrf[' + GA_MAXSRF + '];\n' +
    'out vec4 vCol; out vec2 vTex; flat out uint vAT;\n' +
    // Lerp() of Math/Functions.h: exact ends
    'vec3 lerp3(vec3 a, vec3 b, float r) { return r == 0.0 ? a : (r == 1.0 ? b : a + (b - a) * r); }\n' +
    'ivec4 fr(uint i) { int k = int(i); return texelFetch(uFrames, ivec2(k % uFW, k / uFW), 0); }\n' +
    'vec3 nrm(int c) {\n' +
    '  if ((uFlags & 1u) == 0u) return texelFetch(uNorm, ivec2(c & 255, 1), 0).xyz;\n' +   // avGouraudNormals
    '  vec2 h = texelFetch(uNorm, ivec2(c & 255, 0), 0).xy, p = texelFetch(uNorm, ivec2((c >> 8) & 255, 0), 0).xy;\n' +
    '  return vec3(-h.x * p.y, p.x, -h.y * p.y); }\n' +                                      // (sin, cos) of H and P
    'uvec4 rgba(uint c) { return uvec4(c & 255u, (c >> 8) & 255u, (c >> 16) & 255u, c >> 24); }\n' +
    'void main() {\n' +
    '  uint vx = aV.x & 65535u; uvec4 s = uSrf[aV.x >> 16]; uint m = i0.w;\n' +
    // surface not in the diffuse layer, switched off by the colour mask, or single-sided on the
    // back-side pass: off-screen, so its triangles are clipped away
    '  if ((s.y & 1u) == 0u || (m & s.z) == 0u || (m & s.w) != 0u || ((uFlags & 4u) != 0u && (s.y & 2u) == 0u)) {\n' +
    '    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec4(0.0); vTex = vec2(0.0); vAT = 0u; return; }\n' +
    '  float r = uintBitsToFloat(i0.z);\n' +
    '  ivec4 f0 = fr(i0.x + vx), f1 = fr(i0.y + vx);\n' +
    '  vec3 p = (lerp3(vec3(f0.xyz), vec3(f1.xyz), r) - uOffset) * uintBitsToFloat(i4.xyz);\n' +
    '  vec3 n = lerp3(nrm(f0.w & 65535), nrm(f1.w & 65535), r);\n' +
    '  vec3 L = uintBitsToFloat(i5.xyz);\n' +
    '  float d = n.x * L.x + n.y * L.y + n.z * L.z;\n' +
    '  int sh = clamp(int(d + (d < 0.0 ? -0.5 : 0.5)), 0, 255);\n' +                        // FloatToInt, clamp
    '  ivec3 Lc = ivec3(int(i5.w & 1023u), int((i5.w >> 10) & 1023u), int((i5.w >> 20) & 1023u));\n' +
    '  ivec3 Ac = ivec3(int(i6.x & 1023u), int((i6.x >> 10) & 1023u), int((i6.x >> 20) & 1023u));\n' +
    '  uvec3 mc = uvec3(clamp(Ac + ((Lc * sh) >> 8), 0, 255));\n' +                          // ShadesToColors
    '  uvec4 cs = (rgba(s.x) * rgba(i4.w)) >> 8;\n' +                                        // MultiplyRGBA(srf, model)
    '  uvec4 c;\n' +
    '  if ((s.y & 4u) != 0u) { c = cs; if ((uFlags & 2u) != 0u) c.rgb >>= 1; }\n' +           // fullbright
    '  else c = uvec4((cs.rgb * mc) >> 8, cs.a);\n' +                                         // MultiplyRGBCopyA1
    '  vCol = vec4(c) / 255.0;\n' +
    '  vTex = vec2(uintBitsToFloat(aV.y) * uTexCorr.x, uintBitsToFloat(aV.z) * uTexCorr.y);\n' +
    '  vAT = (s.y >> 3) & 1u;\n' +
    '  vec4 q = vec4(p, 1.0);\n' +
    '  gl_Position = uProj * vec4(dot(uintBitsToFloat(i1), q), dot(uintBitsToFloat(i2), q), dot(uintBitsToFloat(i3), q), 1.0);\n' +
    '}\n';
  var GA_FS = '#version 300 es\nprecision highp float; precision highp int;\n' +
    'uniform sampler2D uTex; uniform float uAlphaRef; uniform uint uFlags;\n' +
    'in vec4 vCol; in vec2 vTex; flat in uint vAT; out vec4 o;\n' +
    'void main() { vec4 c = vCol; vec4 t = texture(uTex, vTex);\n' +
    '  if ((uFlags & 2u) != 0u) { c.rgb = min(c.rgb * t.rgb * 2.0, 1.0); c.a *= t.a; } else c *= t;\n' +   // overbright: COMBINE x2
    '  if (vAT != 0u && !(c.a >= uAlphaRef)) discard;\n' +                                               // alpha test (GEQUAL)
    '  o = c; }\n';
  function gaInit() {
    gaProg = buildProgram(-1, 0, GA_VS, GA_FS);
    if (!gaProg) { gaProg = false; return; }
    gaU = {};
    ['uFrames', 'uNorm', 'uProj', 'uOffset', 'uTexCorr', 'uFW', 'uFlags', 'uSrf', 'uTex', 'uAlphaRef'].forEach(function (n) {
      gaU[n] = gl.getUniformLocation(gaProg, n);
    });
    gl.useProgram(gaProg);
    gl.uniform1i(gaU.uTex, 0); gl.uniform1i(gaU.uFrames, 6); gl.uniform1i(gaU.uNorm, 7);
    gl.useProgram(curProg);
    gaIbuf = gl.createBuffer();
  }
  function gaTex(unit, internal, w, h, fmt, type, data) {
    var t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, fmt, type, data);   // rows are 8n bytes: any UNPACK_ALIGNMENT
    gl.activeTexture(curUnit);
    return t;
  }
  function gaOp(I, F, c, dp) {   // returns the number of words the op takes
    switch (I[c]) {
    case 40: {                   // GA_TABLES ptr len: 256x2 RGBA32F (sin/cos of normal codes; gouraud normals)
      if (gaProg === null) gaInit();
      if (gaNorm) gl.deleteTexture(gaNorm);
      var tp = I[c + 1] >>> 0;
      gaNorm = gaTex(7, gl.RGBA32F, 256, 2, gl.RGBA, gl.FLOAT, new Float32Array(HEAPU8.buffer, tp, 256 * 2 * 4));
      return 3; }
    case 41: {                   // GA_FRAMES h ptr len w h: RGBA16I
      var fp = I[c + 2] >>> 0, fw = I[c + 4], fh = I[c + 5];
      if (gaFrames[I[c + 1]]) gl.deleteTexture(gaFrames[I[c + 1]].tex);
      gaStats.frames++;
      gaFrames[I[c + 1]] = { tex: gaTex(6, gl.RGBA16I, fw, fh, gl.RGBA_INTEGER, gl.SHORT, new Int16Array(HEAPU8.buffer, fp, fw * fh * 4)), w: fw };
      return 6; }
    case 42: {                   // GA_MESH h hFrames vptr vlen iptr ilen
      if (gaProg === null) gaInit();
      var mvao = gl.createVertexArray(), mv = gl.createBuffer(), mi = gl.createBuffer();
      gl.bindVertexArray(mvao);
      gl.bindBuffer(gl.ARRAY_BUFFER, mv);
      var vp = I[c + 3] >>> 0, ip = I[c + 5] >>> 0;
      gl.bufferData(gl.ARRAY_BUFFER, HEAPU8.subarray(vp, vp + I[c + 4]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_INT, 16, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, gaIbuf);
      for (var a = 1; a <= 7; a++) {
        gl.enableVertexAttribArray(a); gl.vertexAttribIPointer(a, 4, gl.UNSIGNED_INT, GA_REC, (a - 1) * 16);
        gl.vertexAttribDivisor(a, 1);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mi);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, HEAPU8.subarray(ip, ip + I[c + 6]), gl.STATIC_DRAW);
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
      gaMeshes[I[c + 1]] = { vao: mvao, vb: mv, ib: mi, frames: I[c + 2] };
      gaStats.meshes++;
      return 7; }
    case 43: {                   // GA_DRAW h instOff ctInst elemFirst ctElem flags aref tcU tcV off3 proj16 ctSrf srf4*n
      var nsrf = I[c + 29], words = 30 + 4 * nsrf;
      var me = gaMeshes[I[c + 1]], fr = me && gaFrames[me.frames];
      if (!gaProg || !fr || !gaNorm || nsrf > GA_MAXSRF) return words;
      gl.useProgram(gaProg);
      if (pf.mrt) emisPrep(gaProg);
      gl.bindVertexArray(me.vao);
      var io = dp + I[c + 2], ct = I[c + 3];
      if (gaInstKey !== io) {   // the back- and front-side passes share their records
        gl.bindBuffer(gl.ARRAY_BUFFER, gaIbuf);
        gl.bufferData(gl.ARRAY_BUFFER, HEAPU8.subarray(io, io + ct * GA_REC), gl.STREAM_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
        gaInstKey = io;
      }
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, fr.tex);
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, gaNorm);
      gl.activeTexture(curUnit);
      gl.uniform1ui(gaU.uFlags, I[c + 6]);
      gl.uniform1f(gaU.uAlphaRef, F[c + 7]);
      gl.uniform2f(gaU.uTexCorr, F[c + 8], F[c + 9]);
      gl.uniform3f(gaU.uOffset, F[c + 10], F[c + 11], F[c + 12]);
      gl.uniformMatrix4fv(gaU.uProj, false, F.subarray(c + 13, c + 29));
      gl.uniform1i(gaU.uFW, fr.w);
      if (nsrf) gl.uniform4uiv(gaU.uSrf, new Uint32Array(HEAP32.buffer, (c + 30) << 2, 4 * nsrf));
      gl.drawElementsInstanced(gl.TRIANGLES, I[c + 5], gl.UNSIGNED_INT, I[c + 4] * 4, ct);
      gaStats.draws++; gaStats.inst += ct;
      gl.bindVertexArray(vao);
      gl.useProgram(curProg);
      return words; }
    case 44: {                   // GA_FREE h (a mesh, or frames)
      var h = I[c + 1], m = gaMeshes[h];
      if (m) { gl.deleteVertexArray(m.vao); gl.deleteBuffer(m.vb); gl.deleteBuffer(m.ib); gaMeshes[h] = null; }
      var f = gaFrames[h];
      if (f) { gl.deleteTexture(f.tex); gaFrames[h] = null; }
      return 2; }
    }
    return 0;
  }

  var api = {
    backend: 'webgl2',
    get gl() { return gl; },
    get gaStats() { return gaStats; },   // the replayer's context (?glstats=1 in port/web/bench.js)
    createProgram: function (vs, fs, key) {   // key: used by the WebGPU replayer only
      sync.createProgram++;
      init();
      var p = buildProgram(0, key >>> 0, vs, fs);
      progs.push(p);
      return progs.length - 1;
    },
    uniformLocation: function (p, name) {
      sync.uniformLocation++;
      var l = progs[p] ? gl.getUniformLocation(progs[p], name) : null;
      if (!l) { ulocs.push(-1); return ulocs.length - 1; }
      ulocs.push(l);
      return ulocs.length - 1;
    },
    // handles are never reused: a deferred delete must not hit a newer texture
    // texture handles come from gl1shim (C); the object is created on first bind
    genTexture: function () { init(); texs.push(gl.createTexture()); return texs.length - 1; },   // (unused)
    // static index buffer turning quads (0,1,2,3) into triangles (0,1,2, 0,2,3)
    quadCapacity: function (ctQuads) {
      sync.other++;
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
    // the synchronous entry (single-threaded build, or a direct call from C) counts as a sync call;
    // the threaded build's OP_TEXIMAGE replay calls texUpload directly and is not one
    texImage: function (sub, target, level, x, y, w, h, fmt, type, ptr, len) {
      sync.other++;
      this.texUpload(sub, target, level, x, y, w, h, fmt, type, ptr, len);
    },
    texUpload: function (sub, target, level, x, y, w, h, fmt, type, ptr, len) {
      init();
      var data = ptr ? HEAPU8.subarray(ptr, ptr + len) : null;
      if (sub) gl.texSubImage2D(target, level, x, y, w, h, fmt, type, data);
      else gl.texImage2D(target, level, gl.RGBA8, w, h, 0, fmt, type, data); // engine always sends RGBA8 pixels
    },
    readPixels: function (x, y, w, h, fmt, type, ptr, len) {
      sync.other++;
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
    endFrame: function () { if (gl) { applyScale(); postRun(); } },
    glError: function () { return gl ? gl.getError() : 0; },
    pixelStore: function (p, v) { sync.other++; init(); gl.pixelStorei(p, v); },
    hasAnisotropy: function () { sync.other++; init(); return !!gl.getExtension('EXT_texture_filter_anisotropic'); },
    sync: function () { if (gl) gl.finish(); return null; },
    // visual regression capture: bottom-up RGBA, delivered to cb (synchronously here)
    capture: function (cb) {
      init();
      if (postOn) postRun();   // capture the final post-processed image (endFrame then skips it)
      var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      cb(px, w, h);
    },
    getParam: function (pname, ptr, isFloat) {
      sync.other++;
      init();
      var v = gl.getParameter(pname), H = isFloat ? HEAPF32 : HEAP32, o = ptr >> 2;
      if (v === null || v === undefined) { H[o] = 0; return 0; }
      if (typeof v === 'number' || typeof v === 'boolean') { H[o] = +v; return 1; }
      if (v.length !== undefined) { for (var i = 0; i < v.length; i++) H[o + i] = +v[i]; return v.length; }
      H[o] = 0; return 0;
    },

    replay: function (cp, n, vp, vn, ip, inn, dp, dn) {
      init();
      if (postOn) {                                                                 // render offscreen
        if (!pf.open) postOpen(); else gl.bindFramebuffer(gl.FRAMEBUFFER, postFbo[pf.split ? pf.out : 0]);
      }
      var I = HEAP32, F = HEAPF32, c = cp >> 2, end = c + n;
      if (probeRes) probePoll();
      gaInstKey = -1;
      if (vn) gl.bufferData(gl.ARRAY_BUFFER, HEAPU8.subarray(vp, vp + vn), gl.STREAM_DRAW);
      if (inn) gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, HEAPU8.subarray(ip, ip + inn), gl.STREAM_DRAW);
      while (c < end) {
        switch (I[c]) {
        case 1:  gl.enable(I[c + 1]); if (I[c + 1] === 0x0BE2) blendOn = true; c += 2; break;    // ENABLE cap
        case 2:  gl.disable(I[c + 1]); if (I[c + 1] === 0x0BE2) blendOn = false; c += 2; break;  // DISABLE cap
        case 3:  gl.blendFunc(bSrc = I[c + 1], bDst = I[c + 2]); c += 3; break;         // BLENDFUNC s d
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
        case 15: gl.clear(I[c + 1]);
                 if (pf.mrt && (I[c + 1] & 0x4000)) {                                  // the emissive target clears to black
                   if (pf.db !== 1) { gl.drawBuffers(DB2); pf.db = 1; }
                   gl.clearBufferfv(gl.COLOR, 1, Z4);
                 }
                 c += 2; break;
        case 16: gl.depthRange(F[c + 1], F[c + 2]); c += 3; break;
        case 17: gl.activeTexture(curUnit = I[c + 1]); c += 2; break;                  // ACTIVETEX enum
        case 18: { var th = I[c + 2];                                                   // BINDTEX target handle
          if (th && !texs[th]) texs[th] = gl.createTexture();                             // first use of a handle
          gl.bindTexture(I[c + 1], th ? texs[th] : null); c += 3; break; }
        case 19: { var tv = I[c + 3];                                                   // TEXPARAMI
          if (I[c + 2] === 0x2801 && tv >= 0x2700 && tv <= 0x2703) {                      // a mipmapped MIN_FILTER
            if (postTrilinear) tv |= 2;                                                   // ..._MIPMAP_LINEAR
            if (postAniso) gl.texParameterf(I[c + 1], 0x84FE, postAniso);                 // TEXTURE_MAX_ANISOTROPY
          }
          gl.texParameteri(I[c + 1], I[c + 2], tv); c += 4; break; }
        case 20: gl.texParameterf(I[c + 1], I[c + 2], F[c + 3]); c += 4; break;
        case 21: if (texs[I[c + 1]]) gl.deleteTexture(texs[I[c + 1]]); texs[I[c + 1]] = null; c += 2; break;
        case 22: gl.useProgram(curProg = progs[I[c + 1]] || null); c += 2; break;
        case 23: if (ulocs[I[c + 1]] !== -1) gl.uniform1i(ulocs[I[c + 1]], I[c + 2]); c += 3; break;
        case 24: if (ulocs[I[c + 1]] !== -1) gl.uniform1f(ulocs[I[c + 1]], F[c + 2]); c += 3; break;
        case 25: if (ulocs[I[c + 1]] !== -1) gl.uniform4f(ulocs[I[c + 1]], F[c + 2], F[c + 3], F[c + 4], F[c + 5]); c += 6; break;
        case 26: if (ulocs[I[c + 1]] !== -1) gl.uniformMatrix4fv(ulocs[I[c + 1]], false, F.subarray(c + 2, c + 18)); c += 18; break;
        case 27: gl.enableVertexAttribArray(I[c + 1]); c += 2; break;
        case 28: gl.disableVertexAttribArray(I[c + 1]); c += 2; break;
        case 29: gl.vertexAttrib4f(I[c + 1], F[c + 2], F[c + 3], F[c + 4], F[c + 5]); c += 6; break;
        case 30: gl.vertexAttribPointer(I[c + 1], I[c + 2], I[c + 3], !!I[c + 4], I[c + 5], sb[I[c + 1]] + I[c + 6]); c += 7; break;
        case 31: if (pf.mrt) emisPrep(curProg);
                 gl.drawElements(I[c + 1], I[c + 2], I[c + 3], I[c + 4]); c += 5; break; // mode count type off
        case 32:                                                                        // DRAW_QUADS count off
          if (pf.mrt) emisPrep(curProg);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, qbuf);
          gl.drawElements(gl.TRIANGLES, I[c + 1], gl.UNSIGNED_INT, I[c + 2]);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
          c += 3; break;
        case 33: if (pf.mrt) emisPrep(curProg);
                 gl.drawArrays(I[c + 1], I[c + 2], I[c + 3]); c += 4; break;           // mode first count
        case 34:                                                                        // TEXIMAGE (data in the data arena)
          this.texUpload(I[c + 1], I[c + 2], I[c + 3], I[c + 4], I[c + 5], I[c + 6], I[c + 7], I[c + 8], I[c + 9],
                        I[c + 10] >= 0 ? dp + I[c + 10] : 0, I[c + 11]);
          c += 12; break;
        case 35: gl.pixelStorei(I[c + 1], I[c + 2]); c += 3; break;                    // PIXELSTORE
        case 38: {                                                                      // NEWPROG h key vsOff vsLen fsOff
          var ph = I[c + 1];
          if (!progs[ph]) {                                                            // sources: strdup'ed, absolute addresses
            var vso = I[c + 3] >>> 0, fso = I[c + 5] >>> 0;
            var vs = utf8(HEAPU8, vso, I[c + 4]);
            var fs = utf8(HEAPU8, fso, I[c + 6]);
            progs[ph] = buildProgram(ph, I[c + 2] >>> 0, vs, fs);
          }
          c += 7; break; }
        case 39: {                                                                      // NEWULOC h prog nameOff nameLen
          var lh = I[c + 1];
          if (ulocs[lh] === undefined) {
            var nso = I[c + 3] >>> 0, nm = utf8(HEAPU8, nso, I[c + 4]);
            var P = progs[I[c + 2]];
            ulocs[lh] = P ? (gl.getUniformLocation(P, nm) || -1) : -1;
          }
          c += 5; break; }
        case 37:                                                                        // DEPTHPROBE n res (slot x y depth) x n
          probeRes = I[c + 2]; depthProbes(I, F, c + 3, I[c + 1]); c += 3 + 4 * I[c + 1]; break;
        case 40: case 41: case 42: case 43: case 44: c += gaOp(I, F, c, dp); break;   // GPU model animation
        case 45: if (postOn) postWorld(); c += 5; break;                                // WORLDEND p0 p5 p10 p14
        case 46: c += 5; break;                                                         // a cancelled WORLDEND
        case 36: {                                                                      // VSTREAMS (ptr len) x6
          var tot = 0, k;
          for (k = 0; k < 6; k++) { sb[k] = tot; tot += (I[c + 2 + 2 * k] + 15) & ~15; }
          if (tot) {
            gl.bufferData(gl.ARRAY_BUFFER, tot, gl.STREAM_DRAW);
            for (k = 0; k < 6; k++) {
              var vsp = I[c + 1 + 2 * k] >>> 0, sn = I[c + 2 + 2 * k];
              if (sn) gl.bufferSubData(gl.ARRAY_BUFFER, sb[k], HEAPU8.subarray(vsp, vsp + sn));
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
  Module['se1GfxSync'] = sync;
  return api;
})();
