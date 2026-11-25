// WebGPU replayer for the gl1shim command stream (render plan phase 2, notes/render-plan.md).
//
// Same interface as the WebGL2 replayer in gfx.js, so the C side doesn't know which one runs.
// Opt-in with ?gfx=webgpu until it passes the visual regression test and wins the benchmark;
// any failure (no WebGPU, no adapter) leaves the WebGL2 replayer in place.
//
// GL semantics mapped onto WebGPU:
//  - GL-style state (blend/depth/cull/colormask/polygon offset/vertex formats/shader key) is
//    shadowed and turned into cached GPURenderPipelines; the key is only rebuilt when it changes.
//  - WGSL is generated from the same shader key gl1shim.c uses for its GLSL (same texenv math).
//    GL constant vertex attributes don't exist in WebGPU: they live in the uniform block and the
//    shader variant knows which inputs are real arrays.
//  - Per-draw uniforms: one large buffer + dynamic offsets (slot reused when nothing changed).
//  - Clip-space z -1..1 -> 0..1; bottom-left viewport/scissor -> top-left; fans/loops -> indices;
//    glClear mid-pass -> clear-quad draw honouring scissor and masks; mip levels arrive one at a
//    time -> texture views cover the levels uploaded so far.
//  - SDL's canvas holds the WebGL context, so WebGPU draws into an overlay canvas
//    (pointer-events: none) and input still reaches SDL's canvas underneath.
(function () {
  if (new URLSearchParams(location.search).get('gfx') !== 'webgpu') return;
  if (new URLSearchParams(location.search).get('post')) console.warn('se1gfx: ?post= ignored with ?gfx=webgpu');
  Module['preRun'] = (Module['preRun'] || []).concat([function () {
    if (!navigator.gpu) { console.warn('se1gfx: WebGPU not available, using WebGL2'); return; }
    addRunDependency('se1-webgpu');
    navigator.gpu.requestAdapter()
      .then(function (a) { return a ? a.requestDevice() : null; })
      .then(function (dev) {
        if (dev) { Module['se1gfx'] = makeWebGPU(dev); console.log('se1gfx: WebGPU replayer'); }
        else console.warn('se1gfx: no WebGPU adapter, using WebGL2');
      })
      .catch(function (e) { console.warn('se1gfx: WebGPU init failed, using WebGL2', e); })
      .finally(function () { removeRunDependency('se1-webgpu'); });
  }]);

  function makeWebGPU(dev) {
    var sync = { createProgram: 0, uniformLocation: 0, other: 0 };   // Module.se1GfxSync
    var fmt = navigator.gpu.getPreferredCanvasFormat();
    var errors = 0;
    dev.onuncapturederror = function (e) { if (errors++ < 20) console.error('se1gfx webgpu:', e.error.message); };

    // ---- GL enums ----
    var G = {
      BLEND: 0x0BE2, CULL_FACE: 0x0B44, DEPTH_TEST: 0x0B71, SCISSOR_TEST: 0x0C11, POLYGON_OFFSET_FILL: 0x8037,
      FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408, CW: 0x0900, CCW: 0x0901,
      COLOR_BIT: 0x4000, DEPTH_BIT: 0x0100,
      FLOAT: 0x1406, UNSIGNED_BYTE: 0x1401, UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405,
      TEXTURE0: 0x84C0, MIN_FILTER: 0x2801, MAG_FILTER: 0x2800, WRAP_S: 0x2802, WRAP_T: 0x2803, MAX_ANISO: 0x84FE,
      NEAREST: 0x2600, LINEAR: 0x2601, NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701,
      NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
      REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370
    };
    var DEPTH_FUNC = { 0x0200: 'never', 0x0201: 'less', 0x0202: 'equal', 0x0203: 'less-equal',
                       0x0204: 'greater', 0x0205: 'not-equal', 0x0206: 'greater-equal', 0x0207: 'always' };
    var BLEND_F = { 0: 'zero', 1: 'one', 0x0300: 'src', 0x0301: 'one-minus-src', 0x0302: 'src-alpha',
                    0x0303: 'one-minus-src-alpha', 0x0304: 'dst-alpha', 0x0305: 'one-minus-dst-alpha',
                    0x0306: 'dst', 0x0307: 'one-minus-dst', 0x0308: 'src-alpha-saturated' };
    var TOPO = { 0: 'point-list', 1: 'line-list', 3: 'line-strip', 4: 'triangle-list', 5: 'triangle-strip' };
    var WRAP = {}; WRAP[G.REPEAT] = 'repeat'; WRAP[G.CLAMP_TO_EDGE] = 'clamp-to-edge'; WRAP[G.MIRRORED_REPEAT] = 'mirror-repeat';

    // ---- uniform block layout (floats): must match the WGSL struct U ----
    var U_FLOATS = 144, U_STRIDE = 768;            // 576 bytes used, slots 256-aligned for dynamic offsets
    var UNIFORM_OFF = { uMVP: [0, 16], uMV: [16, 16], uClip: [96, 4], uAlphaRef: [116, 1] };
    for (var i = 0; i < 4; i++) { UNIFORM_OFF['uTexMat[' + i + ']'] = [32 + 16 * i, 16]; UNIFORM_OFF['uEnv' + i] = [100 + 4 * i, 4]; }
    var ATTR_OFF = 120;                             // attr[6] vec4f: constant vertex attributes

    // ---- device objects ----
    var bgl0 = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 576 } }] });
    var bgl1entries = [];
    for (i = 0; i < 4; i++) bgl1entries.push({ binding: i, visibility: GPUShaderStage.FRAGMENT, texture: {} });
    for (i = 0; i < 4; i++) bgl1entries.push({ binding: 4 + i, visibility: GPUShaderStage.FRAGMENT, sampler: {} });
    var bgl1 = dev.createBindGroupLayout({ entries: bgl1entries });
    var layout = dev.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] });

    var dummyTex = dev.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: dummyTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    var dummyView = dummyTex.createView(), dummySampler = dev.createSampler();

    // growable GPU buffers (recreated bigger; replay never needs more than one flush's worth)
    function GrowBuf(usage, initial) { this.usage = usage; this.size = 0; this.buf = null; this.ensure(initial); }
    GrowBuf.prototype.ensure = function (n) {
      if (n <= this.size) return false;
      var sz = Math.max(this.size, 1 << 16); while (sz < n) sz *= 2;
      if (this.buf) this.buf.destroy();
      this.buf = dev.createBuffer({ size: sz, usage: this.usage | GPUBufferUsage.COPY_DST });
      this.size = sz;
      return true;
    };
    var vbuf = new GrowBuf(GPUBufferUsage.VERTEX, 4 << 20);
    var sb = [0, 0, 0, 0, 0, 0];   // this batch's vertex stream bases in vbuf (OP_VSTREAMS)
    var ibuf = new GrowBuf(GPUBufferUsage.INDEX, 1 << 20);
    var qbuf = null, qcap = 0;

    // uniform + generated-index buffers are filled during replay, written before submit:
    // segments, so a flush can outgrow one without invalidating draws already recorded
    function SegPool(usage, slotBytes, slots) { this.usage = usage; this.slotBytes = slotBytes; this.slots = slots; this.segs = []; this.reset(); }
    SegPool.prototype.reset = function () { this.cur = 0; this.used = 0; };
    SegPool.prototype.seg = function () {
      var s = this.segs[this.cur];
      if (!s) {
        s = { buf: dev.createBuffer({ size: this.slotBytes * this.slots, usage: this.usage | GPUBufferUsage.COPY_DST }),
              data: new ArrayBuffer(this.slotBytes * this.slots), bg: null };
        s.f32 = new Float32Array(s.data); s.u32 = new Uint32Array(s.data);   // views made once, not per draw
        this.segs[this.cur] = s;
      }
      return s;
    };
    // returns [segment, byteOffset] of the next free slot
    SegPool.prototype.alloc = function (nSlots) {
      if (this.used + nSlots > this.slots) { this.flushSeg(); this.cur++; this.used = 0; }
      var s = this.seg(), off = this.used * this.slotBytes;
      this.used += nSlots; s.dirtyEnd = this.used * this.slotBytes;
      return [s, off];
    };
    SegPool.prototype.flushSeg = function () {
      var s = this.segs[this.cur];
      if (s && s.dirtyEnd) { dev.queue.writeBuffer(s.buf, 0, s.data, 0, s.dirtyEnd); s.dirtyEnd = 0; }
    };
    SegPool.prototype.finish = function () { this.flushSeg(); this.reset(); };
    var upool = new SegPool(GPUBufferUsage.UNIFORM, U_STRIDE, 2048);
    var xpool = new SegPool(GPUBufferUsage.INDEX, 4, 1 << 18);      // generated indices (fans, loops, u8)

    // ---- canvas / attachments ----
    var glCanvas = null, canvas = null, ctx = null, depthTex = null, depthView = null, W = 0, H = 0, layoutTick = 0, resized = false;
    function ensureTarget() {
      if (!canvas) {
        glCanvas = Module['canvas'];
        canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.pointerEvents = 'none';
        glCanvas.parentNode.insertBefore(canvas, glCanvas.nextSibling);
        ctx = canvas.getContext('webgpu');
      }
      // render scale: SDL's canvas has the engine's logical size; we draw at curScale of it
      var bw = Math.max(1, Math.round(glCanvas.width * curScale)), bh = Math.max(1, Math.round(glCanvas.height * curScale));
      logW = glCanvas.width; logH = glCanvas.height;
      if (bw !== W || bh !== H) {
        W = canvas.width = bw; H = canvas.height = bh; resized = true;
        ctx.configure({ device: dev, format: fmt, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        if (depthTex) depthTex.destroy();
        depthTex = dev.createTexture({ size: [W, H], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
        depthView = depthTex.createView();
      }
      // keep the overlay on top of SDL's canvas (layout reads can force a reflow: not every flush)
      if (++layoutTick % 60 !== 1 && !resized) return;
      resized = false;
      var s = canvas.style, l = glCanvas.offsetLeft + 'px', t = glCanvas.offsetTop + 'px',
          w = glCanvas.clientWidth + 'px', h = glCanvas.clientHeight + 'px';
      if (s.left !== l) s.left = l; if (s.top !== t) s.top = t;
      if (s.width !== w) s.width = w; if (s.height !== h) s.height = h;
    }
    var curScale = 1, logW = 1, logH = 1;

    // ---- objects owned by the replayer (integer handles, 0 = none) ----
    var progs = [null], ulocs = [null], texs = [null];
    function newTex() {
      return { tex: null, w: 0, h: 0, levels: 0, have: [], view: null, viewLevels: 0, vid: 0,
               params: { min: G.NEAREST_MIPMAP_LINEAR, mag: G.LINEAR, ws: G.REPEAT, wt: G.REPEAT, aniso: 1 } };
    }
    var samplers = new Map(), viewId = 1;

    // ---- shadowed GL state ----
    var st = {
      blend: 0, cull: 0, depthTest: 0, scissorTest: 0, polyOffset: 0,
      blendS: 1, blendD: 0, depthFunc: 0x0201, depthMask: 1, colorMask: 15, cullFace: G.BACK, frontFace: G.CCW,
      poF: 0, poU: 0, vp: [0, 0, 0, 0], sc: [0, 0, 0, 0], clearColor: [0, 0, 0, 0], clearDepth: 1, dnear: 0, dfar: 1,
      unit: 0, bound: [0, 0, 0, 0], prog: 0,
      attrOn: 0, attr: [], attrConst: new Float32Array(24)
    };
    for (i = 0; i < 6; i++) { st.attr.push({ size: 4, type: G.FLOAT, norm: 0, stride: 16, off: 0 }); st.attrConst[i * 4 + 3] = 1; }

    // ---- WGSL ----
    function wgsl(key, attrMask) {
      var s = 'struct U { mvp: mat4x4f, mv: mat4x4f, texMat: array<mat4x4f, 4>, clip: vec4f, env: array<vec4f, 4>, ' +
              'alphaRef: f32, p0: f32, p1: f32, p2: f32, attr: array<vec4f, 6> };\n' +
              '@group(0) @binding(0) var<uniform> u: U;\n';
      for (var i = 0; i < 4; i++) s += '@group(1) @binding(' + i + ') var t' + i + ': texture_2d<f32>;\n';
      for (i = 0; i < 4; i++) s += '@group(1) @binding(' + (4 + i) + ') var s' + i + ': sampler;\n';
      s += 'struct VOut { @builtin(position) pos: vec4f, @location(0) col: vec4f, @location(1) t0: vec4f, ' +
           '@location(2) t1: vec4f, @location(3) t2: vec4f, @location(4) t3: vec4f, @location(5) clipd: f32 };\n';
      var ins = [];
      for (i = 0; i < 6; i++) if (attrMask & (1 << i)) ins.push('@location(' + i + ') a' + i + ': vec4f');
      var a = function (l) { return (attrMask & (1 << l)) ? 'i.a' + l : 'u.attr[' + l + ']'; };
      s += ins.length ? 'struct VIn { ' + ins.join(', ') + ' };\n@vertex fn vs(i: VIn) -> VOut {\n' : '@vertex fn vs() -> VOut {\n';
      s += ' var o: VOut;\n let p = ' + a(0) + ';\n o.pos = u.mvp * p;\n o.pos.z = (o.pos.z + o.pos.w) * 0.5;\n o.col = ' + a(1) + ';\n';
      for (i = 0; i < 4; i++) s += ' o.t' + i + ' = u.texMat[' + i + '] * ' + a(2 + i) + ';\n';
      s += ' o.clipd = dot(u.mv * p, u.clip);\n return o;\n}\n';
      s += '@fragment fn fs(v: VOut) -> @location(0) vec4f {\n var c = v.col;\n';
      // sample first: textureSample needs uniform control flow, discards come last
      for (i = 0; i < 4; i++) if ((key >> (i * 4)) & 1) s += ' let x' + i + ' = textureSample(t' + i + ', s' + i + ', v.t' + i + '.xy / v.t' + i + '.w);\n';
      for (i = 0; i < 4; i++) {
        var e = (key >> (i * 4)) & 0xF;
        if (!(e & 1)) continue;
        var x = 'x' + i, env = 'u.env[' + i + ']';
        switch (e >> 1) {
        case 1: s += ' c = ' + x + ';\n'; break;                                                         // REPLACE
        case 2: s += ' c = vec4f(mix(c.rgb, ' + x + '.rgb, ' + x + '.a), c.a);\n'; break;                // DECAL
        case 3: s += ' c = vec4f(mix(c.rgb, ' + env + '.rgb, ' + x + '.rgb), c.a * ' + x + '.a);\n'; break; // BLEND
        case 4: s += ' c = vec4f(min(c.rgb + ' + x + '.rgb, vec3f(1.0)), c.a * ' + x + '.a);\n'; break;  // ADD
        case 5: s += ' c = vec4f(min(c.rgb * ' + x + '.rgb * ' + env + '.w, vec3f(1.0)), c.a * ' + x + '.a);\n'; break;
        case 6: s += ' c = vec4f(min(' + x + '.rgb * ' + env + '.w, vec3f(1.0)), c.a * ' + x + '.a);\n'; break;
        case 7: s += ' c = vec4f(min((c.rgb + ' + x + '.rgb) * ' + env + '.w, vec3f(1.0)), c.a * ' + x + '.a);\n'; break;
        default: s += ' c = c * ' + x + ';\n';                                                           // MODULATE
        }
      }
      if (key & (1 << 20)) s += ' if (v.clipd < 0.0) { discard; }\n';
      var af = (key >> 16) & 0xF;
      if (af) {
        var cmp = ['false', 'c.a < u.alphaRef', 'c.a == u.alphaRef', 'c.a <= u.alphaRef', 'c.a > u.alphaRef',
                   'c.a != u.alphaRef', 'c.a >= u.alphaRef', 'true'][af - 1];
        s += ' if (!(' + cmp + ')) { discard; }\n';
      }
      return s + ' return c;\n}\n';
    }
    var CLEAR_WGSL =
      'struct U { mvp: mat4x4f, mv: mat4x4f, texMat: array<mat4x4f, 4>, clip: vec4f, env: array<vec4f, 4>, ' +
      'alphaRef: f32, p0: f32, p1: f32, p2: f32, attr: array<vec4f, 6> };\n' +
      '@group(0) @binding(0) var<uniform> u: U;\n' +
      '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n' +
      ' let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;\n return vec4f(xy, u.attr[1].x, 1.0);\n}\n' +
      '@fragment fn fs() -> @location(0) vec4f { return u.attr[0]; }\n';
    var clearModule = null;

    // ---- pipelines ----
    var pipelines = new Map();
    function vfmt(a) {
      if (a.type === G.FLOAT) return a.size === 1 ? 'float32' : 'float32x' + a.size;
      if (a.type === G.UNSIGNED_BYTE) return 'unorm8x4';
      return 'float32x' + a.size;
    }
    function pipelineFor(topo, stripFmt) {
      var P = progs[st.prog];
      if (!P) return null;
      var key = P.key + '|' + st.attrOn + '|' + topo + '|' + (stripFmt || '') + '|' + st.blend + ',' + st.blendS + ',' + st.blendD +
                '|' + st.depthTest + ',' + st.depthFunc + ',' + st.depthMask + '|' + st.cull + ',' + st.cullFace + ',' + st.frontFace +
                '|' + st.colorMask + '|' + st.polyOffset + ',' + st.poF + ',' + st.poU;
      for (var l = 0; l < 6; l++) if (st.attrOn & (1 << l)) key += '|' + vfmt(st.attr[l]) + ',' + st.attr[l].stride;
      var pl = pipelines.get(key);
      if (pl) return pl;
      var mkey = P.key + ':' + st.attrOn, mod = P.modules[mkey];
      if (!mod) mod = P.modules[mkey] = dev.createShaderModule({ code: wgsl(P.key, st.attrOn) });
      var buffers = [];
      for (l = 0; l < 6; l++) {
        buffers.push((st.attrOn & (1 << l)) ? { arrayStride: st.attr[l].stride,
          attributes: [{ shaderLocation: l, offset: 0, format: vfmt(st.attr[l]) }] } : null);
      }
      var tri = topo === 'triangle-list' || topo === 'triangle-strip';
      var target = { format: fmt, writeMask: st.colorMask };
      if (st.blend) {
        var b = { srcFactor: BLEND_F[st.blendS] || 'one', dstFactor: BLEND_F[st.blendD] || 'zero', operation: 'add' };
        target.blend = { color: b, alpha: { srcFactor: b.srcFactor === 'src-alpha-saturated' ? 'one' : b.srcFactor, dstFactor: b.dstFactor, operation: 'add' } };
      }
      var prim = { topology: topo, cullMode: st.cull ? (st.cullFace === G.FRONT ? 'front' : 'back') : 'none',
                   frontFace: st.frontFace === G.CW ? 'cw' : 'ccw' };
      if (stripFmt) prim.stripIndexFormat = stripFmt;
      pl = dev.createRenderPipeline({
        layout: layout,
        vertex: { module: mod, entryPoint: 'vs', buffers: buffers },
        fragment: { module: mod, entryPoint: 'fs', targets: [target] },
        primitive: prim,
        depthStencil: { format: 'depth32float', depthWriteEnabled: !!(st.depthTest && st.depthMask),
                        depthCompare: st.depthTest ? (DEPTH_FUNC[st.depthFunc] || 'less') : 'always',
                        depthBias: tri && st.polyOffset ? Math.round(st.poU) : 0,
                        depthBiasSlopeScale: tri && st.polyOffset ? st.poF : 0 }
      });
      pipelines.set(key, pl);
      return pl;
    }
    function clearPipeline(colorMask, depthWrite) {
      var key = 'clear|' + colorMask + '|' + depthWrite, pl = pipelines.get(key);
      if (pl) return pl;
      if (!clearModule) clearModule = dev.createShaderModule({ code: CLEAR_WGSL });
      pl = dev.createRenderPipeline({
        layout: layout,
        vertex: { module: clearModule, entryPoint: 'vs' },
        fragment: { module: clearModule, entryPoint: 'fs', targets: [{ format: fmt, writeMask: colorMask }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: !!depthWrite, depthCompare: 'always' }
      });
      pipelines.set(key, pl);
      return pl;
    }

    // ---- textures / samplers ----
    function samplerFor(t) {
      if (t.samp) return t.samp;                     // reset by glTexParameter on this texture
      var p = t.params, key = p.min + ',' + p.mag + ',' + p.ws + ',' + p.wt + ',' + p.aniso, s = samplers.get(key);
      if (s) return (t.samp = s);
      var mipmapped = p.min !== G.NEAREST && p.min !== G.LINEAR;
      var minF = (p.min === G.NEAREST || p.min === G.NEAREST_MIPMAP_NEAREST || p.min === G.NEAREST_MIPMAP_LINEAR) ? 'nearest' : 'linear';
      var mipF = (p.min === G.NEAREST_MIPMAP_LINEAR || p.min === G.LINEAR_MIPMAP_LINEAR) ? 'linear' : 'nearest';
      var magF = p.mag === G.NEAREST ? 'nearest' : 'linear';
      var desc = { minFilter: minF, magFilter: magF, mipmapFilter: mipF,
                   addressModeU: WRAP[p.ws] || 'repeat', addressModeV: WRAP[p.wt] || 'repeat',
                   lodMinClamp: 0, lodMaxClamp: mipmapped ? 32 : 0 };
      if (p.aniso > 1 && minF === 'linear' && magF === 'linear' && mipF === 'linear') desc.maxAnisotropy = Math.min(16, p.aniso | 0);
      s = dev.createSampler(desc);
      s.__id = samplers.size + 1;
      samplers.set(key, s);
      return (t.samp = s);
    }
    var tbgCache = new Map();
    function textureBindGroup(key) {
      // common case: only unit 0 is used -> bind group cached on the texture itself
      if ((key & 0x1111) === 1) {
        var t0 = texs[st.bound[0]];
        if (t0 && t0.view) {
          var sm0 = samplerFor(t0);
          if (t0.bg && t0.bgVid === t0.vid && t0.bgSamp === sm0) return t0.bg;
          var e0 = [{ binding: 0, resource: t0.view }];
          for (var d = 1; d < 4; d++) e0.push({ binding: d, resource: dummyView });
          e0.push({ binding: 4, resource: sm0 });
          for (d = 1; d < 4; d++) e0.push({ binding: 4 + d, resource: dummySampler });
          t0.bg = dev.createBindGroup({ layout: bgl1, entries: e0 }); t0.bgVid = t0.vid; t0.bgSamp = sm0;
          return t0.bg;
        }
      }
      var views = [], smps = [], k = '';
      for (var u = 0; u < 4; u++) {
        var t = ((key >> (u * 4)) & 1) ? texs[st.bound[u]] : null;
        if (t && t.view) { var sm = samplerFor(t); views.push(t.view); smps.push(sm); k += t.vid + ':' + sm.__id + ','; }
        else { views.push(dummyView); smps.push(dummySampler); k += '0,'; }
      }
      var bg = tbgCache.get(k);
      if (!bg) {
        if (tbgCache.size > 8192) tbgCache.clear();
        var entries = [];
        for (u = 0; u < 4; u++) entries.push({ binding: u, resource: views[u] });
        for (u = 0; u < 4; u++) entries.push({ binding: 4 + u, resource: smps[u] });
        bg = dev.createBindGroup({ layout: bgl1, entries: entries });
        tbgCache.set(k, bg);
      }
      return bg;
    }
    function updateView(t) {
      var n = 0; while (n < t.levels && t.have[n]) n++;
      if (n !== t.viewLevels) { t.viewLevels = n; t.view = n ? t.tex.createView({ baseMipLevel: 0, mipLevelCount: n }) : null; t.vid = viewId++; }
    }

    // Emscripten's GL object (SDL's WebGL2 context): only for constant queries
    function GL_ctx() { return (typeof GL !== 'undefined' && GL.currentContext) ? GL.currentContext.GLctx : null; }

    var warnedRead = false, fences = [];
    var api = {
      backend: 'webgpu',
      createProgram: function (vs, fs, key) { sync.createProgram++; progs.push({ key: key >>> 0, shadow: new Float32Array(120), modules: {} }); return progs.length - 1; },
      uniformLocation: function (p, name) {
        sync.uniformLocation++;
        var o = UNIFORM_OFF[name];
        if (!o) { ulocs.push(-1); return ulocs.length - 1; }   // samplers: fixed bindings, nothing to set
        ulocs.push({ p: p, off: o[0], n: o[1] });
        return ulocs.length - 1;
      },
      genTexture: function () { texs.push(newTex()); return texs.length - 1; },   // (unused: handles come from gl1shim)
      quadCapacity: function (ctQuads) {
        sync.other++;
        if (ctQuads <= qcap) return;
        var cap = 1024; while (cap < ctQuads) cap *= 2;
        var idx = new Uint32Array(cap * 6);
        for (var q = 0; q < cap; q++) {
          var b = q * 4, o = q * 6;
          idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2; idx[o + 3] = b; idx[o + 4] = b + 2; idx[o + 5] = b + 3;
        }
        qbuf = dev.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
        dev.queue.writeBuffer(qbuf, 0, idx);
        qcap = cap;
      },
      // synchronous entry counts as a sync call; the OP_TEXIMAGE replay calls texUpload directly
      texImage: function (sub, target, level, x, y, w, h, fmtGL, type, ptr, len) {
        sync.other++;
        api.texUpload(sub, target, level, x, y, w, h, fmtGL, type, ptr, len);
      },
      texUpload: function (sub, target, level, x, y, w, h, fmtGL, type, ptr, len) {
        var t = texs[st.bound[st.unit]];
        if (!t) return;
        if (!sub) {
          if (level === 0 && (!t.tex || t.w !== w || t.h !== h)) {
            if (t.tex) t.tex.destroy();
            t.w = w; t.h = h; t.levels = Math.floor(Math.log2(Math.max(w, h))) + 1; t.have = [];
            t.tex = dev.createTexture({ size: [w, h], format: 'rgba8unorm', mipLevelCount: t.levels,
                                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
            t.viewLevels = -1;
          }
          if (!t.tex || level >= t.levels || w !== Math.max(1, t.w >> level) || h !== Math.max(1, t.h >> level)) return;
          x = 0; y = 0;
        } else if (!t.tex) return;
        if (ptr) dev.queue.writeTexture({ texture: t.tex, mipLevel: level, origin: [x, y] }, HEAPU8,
                                        { offset: ptr, bytesPerRow: w * 4, rowsPerImage: h }, [w, h]);
        if (!sub) { t.have[level] = 1; updateView(t); }
      },
      readPixels: function (x, y, w, h, fmtGL, type, ptr, len) {
        sync.other++;
        // engine read-backs (screenshots, thumbnails) need a synchronous answer WebGPU can't give
        HEAPU8.fill(0, ptr, ptr + len);
        if (!warnedRead) { warnedRead = true; console.warn('se1gfx webgpu: glReadPixels is not supported (returns black)'); }
      },
      pixelStore: function () {},
      hasAnisotropy: function () { return true; },   // WebGPU samplers support maxAnisotropy
      getParam: function (pname, ptr, isFloat) {   // constants: SDL's WebGL2 context still exists
        sync.other++;
        var gl = GL_ctx(), H32 = isFloat ? HEAPF32 : HEAP32, o = ptr >> 2, v;
        if (gl) v = gl.getParameter(pname);
        else v = ({ 0x0D33: dev.limits.maxTextureDimension2D, 0x84FF: 16, 0x84E2: 4 })[pname] || 0;  // threads build: no GL context
        if (v === null || v === undefined) { H32[o] = 0; return 0; }
        if (typeof v === 'number' || typeof v === 'boolean') { H32[o] = +v; return 1; }
        if (v.length !== undefined) { for (var i = 0; i < v.length; i++) H32[o + i] = +v[i]; return v.length; }
        H32[o] = 0; return 0;
      },
      // timedemo: wait for the frame from 2 frames ago, not this one (bounded queue, no full stall)
      // once per frame after the swap flush: a new render scale takes effect next frame
      endFrame: function () { curScale = Math.min(1, Math.max(0.25, Module['se1Scale'] || 1)); },
      sync: function () { fences.push(dev.queue.onSubmittedWorkDone()); return fences.length > 2 ? fences.shift() : null; },
      // visual regression capture: copy the frame, deliver bottom-up RGBA like glReadPixels
      capture: function (cb) {
        var tex = ctx.getCurrentTexture(), w = tex.width, h = tex.height, bpr = Math.ceil(w * 4 / 256) * 256;
        var buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        var enc = dev.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
        dev.queue.submit([enc.finish()]);
        var bgra = fmt.indexOf('bgra') === 0;
        buf.mapAsync(GPUMapMode.READ).then(function () {
          var src = new Uint8Array(buf.getMappedRange()), out = new Uint8Array(w * h * 4);
          for (var yy = 0; yy < h; yy++) {
            var si = (h - 1 - yy) * bpr, di = yy * w * 4;
            for (var xx = 0; xx < w; xx++, si += 4, di += 4) {
              out[di] = src[si + (bgra ? 2 : 0)]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + (bgra ? 0 : 2)]; out[di + 3] = 255;   // canvas is alphaMode 'opaque': alpha isn't shown
            }
          }
          buf.unmap(); buf.destroy();
          cb(out, w, h);
        });
      },

      replay: function (cp, n, vp, vn, ip, inn, dp, dn) {
        ensureTarget();
        if (vn) { vbuf.ensure(vn); dev.queue.writeBuffer(vbuf.buf, 0, HEAPU8, vp, (vn + 3) & ~3); }
        if (inn) { ibuf.ensure(inn); dev.queue.writeBuffer(ibuf.buf, 0, HEAPU8, ip, (inn + 3) & ~3); }
        var I = HEAP32, F = HEAPF32, c = cp >> 2, end = c + n;
        var colorView = ctx.getCurrentTexture().createView();
        function beginPass() {
          enc = dev.createCommandEncoder();
          pass = enc.beginRenderPass({
            colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
            depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' }
          });
        }
        var enc, pass;
        beginPass();
        // per-pass dirty tracking
        var pipeDirty = true, texDirty = true, uniDirty = true, vpDirty = true, scDirty = true;
        var curPipe = null, curTBG = null, lastU = null, lastIdx = null, vbOff = [-1, -1, -1, -1, -1, -1], lastTopo = null, lastStrip;

        var sx = W / logW, sy = H / logH;   // logical (engine) -> backing pixels
        function setViewport() {
          var x0 = Math.round(st.vp[0] * sx), y0 = Math.round(st.vp[1] * sy);
          var vw = Math.round((st.vp[0] + st.vp[2]) * sx) - x0, vh = Math.round((st.vp[1] + st.vp[3]) * sy) - y0;
          var x = Math.max(0, x0), w = Math.min(vw, W - x), y = Math.max(0, H - y0 - vh), h = Math.min(vh, H - y);
          if (w > 0 && h > 0) pass.setViewport(x, y, w, h, Math.min(st.dnear, st.dfar), Math.max(st.dnear, st.dfar));
          vpDirty = false;
        }
        function setScissor() {
          if (!st.scissorTest) pass.setScissorRect(0, 0, W, H);
          else {
            var s0 = Math.round(st.sc[0] * sx), s1 = Math.round(st.sc[1] * sy);
            var sw = Math.round((st.sc[0] + st.sc[2]) * sx) - s0, sh = Math.round((st.sc[1] + st.sc[3]) * sy) - s1;
            var x = Math.max(0, Math.min(W, s0)), y = Math.max(0, Math.min(H, H - s1 - sh));
            var w = Math.max(0, Math.min(W - x, sw)), h = Math.max(0, Math.min(H - y, sh));
            pass.setScissorRect(x, y, w, h);
          }
          scDirty = false;
        }
        var boundU = null;   // uniform slot currently bound to group 0 in this pass
        function uniforms() {
          if (!uniDirty && lastU) {
            if (boundU !== lastU) { pass.setBindGroup(0, lastU[0].bg, [lastU[1]]); boundU = lastU; }
            return;
          }
          var a = upool.alloc(1), seg = a[0], base = a[1] >> 2, P = progs[st.prog];
          if (P) seg.f32.set(P.shadow, base);
          seg.f32.set(st.attrConst, base + ATTR_OFF);
          if (!seg.bg) seg.bg = dev.createBindGroup({ layout: bgl0, entries: [{ binding: 0, resource: { buffer: seg.buf, size: 576 } }] });
          pass.setBindGroup(0, seg.bg, [a[1]]);
          lastU = boundU = a; uniDirty = false;
        }
        // common part of every draw; returns false if nothing should be drawn
        function prep(topo, stripFmt) {
          if (st.cull && st.cullFace === G.FRONT_AND_BACK) return false;
          var P = progs[st.prog];
          if (!P) return false;
          var pl;
          if (!pipeDirty && curPipe && topo === lastTopo && stripFmt === lastStrip) pl = curPipe;
          else { pl = pipelineFor(topo, stripFmt); lastTopo = topo; lastStrip = stripFmt; pipeDirty = false; }
          if (pl !== curPipe) { pass.setPipeline(pl); curPipe = pl; }
          if (vpDirty) setViewport();
          if (scDirty) setScissor();
          uniforms();
          if (texDirty) { var bg = textureBindGroup(P.key); if (bg !== curTBG) { pass.setBindGroup(1, bg); curTBG = bg; } texDirty = false; }
          for (var l = 0; l < 6; l++) if ((st.attrOn & (1 << l)) && vbOff[l] !== st.attr[l].off) { pass.setVertexBuffer(l, vbuf.buf, st.attr[l].off); vbOff[l] = st.attr[l].off; }
          return true;
        }
        // queue.writeTexture runs ahead of not-yet-submitted draws: submit what was recorded so far,
        // upload, then continue in a fresh pass, so draws see texture contents in GL order
        function splitForUpload() {
          pass.end(); upool.finish(); xpool.finish(); dev.queue.submit([enc.finish()]);
          beginPass();
          pipeDirty = texDirty = uniDirty = vpDirty = scDirty = true;
          curPipe = null; curTBG = null; lastU = null; boundU = null; lastIdx = null; lastTopo = null;
          vbOff = [-1, -1, -1, -1, -1, -1];
        }
        function genIndices(list) {
          var a = xpool.alloc(list.length);
          a[0].u32.set(list, a[1] >> 2);
          return a;
        }
        function drawGen(topo, list) {
          if (!list.length || !prep(topo)) return;
          var a = genIndices(list);
          pass.setIndexBuffer(a[0].buf, 'uint32', a[1], list.length * 4); lastIdx = null;
          pass.drawIndexed(list.length);
        }

        while (c < end) {
          switch (I[c]) {
          case 1: case 2: {                                                    // ENABLE / DISABLE
            var on = I[c] === 1 ? 1 : 0, cap = I[c + 1];
            if (cap === G.BLEND) st.blend = on; else if (cap === G.CULL_FACE) st.cull = on;
            else if (cap === G.DEPTH_TEST) st.depthTest = on; else if (cap === G.POLYGON_OFFSET_FILL) st.polyOffset = on;
            else if (cap === G.SCISSOR_TEST) { st.scissorTest = on; scDirty = true; }
            pipeDirty = true; c += 2; break;
          }
          case 3: st.blendS = I[c + 1]; st.blendD = I[c + 2]; pipeDirty = true; c += 3; break;
          case 4: st.depthFunc = I[c + 1]; pipeDirty = true; c += 2; break;
          case 5: st.depthMask = I[c + 1]; pipeDirty = true; c += 2; break;
          case 6: st.colorMask = (I[c + 1] ? 1 : 0) | (I[c + 2] ? 2 : 0) | (I[c + 3] ? 4 : 0) | (I[c + 4] ? 8 : 0); pipeDirty = true; c += 5; break;
          case 7: st.cullFace = I[c + 1]; pipeDirty = true; c += 2; break;
          case 8: st.frontFace = I[c + 1]; pipeDirty = true; c += 2; break;
          case 9: st.poF = F[c + 1]; st.poU = F[c + 2]; pipeDirty = true; c += 3; break;
          case 10: st.vp = [I[c + 1], I[c + 2], I[c + 3], I[c + 4]]; vpDirty = true; c += 5; break;
          case 11: st.sc = [I[c + 1], I[c + 2], I[c + 3], I[c + 4]]; scDirty = true; c += 5; break;
          case 12: st.clearColor = [F[c + 1], F[c + 2], F[c + 3], F[c + 4]]; c += 5; break;
          case 13: st.clearDepth = F[c + 1]; c += 2; break;
          case 14: c += 2; break;                                              // CLEARSTENCIL: no stencil
          case 15: {                                                           // CLEAR mask
            var mask = I[c + 1], cm = (mask & G.COLOR_BIT) ? st.colorMask : 0, dw = (mask & G.DEPTH_BIT) && st.depthMask;
            if (cm || dw) {
              pass.setPipeline(clearPipeline(cm, dw)); curPipe = null; pipeDirty = true;
              var a = upool.alloc(1), cb = a[1] >> 2, f = a[0].f32;
              f.fill(0, cb, cb + U_FLOATS); f.set(st.clearColor, cb + ATTR_OFF); f[cb + ATTR_OFF + 4] = st.clearDepth;
              if (!a[0].bg) a[0].bg = dev.createBindGroup({ layout: bgl0, entries: [{ binding: 0, resource: { buffer: a[0].buf, size: 576 } }] });
              pass.setBindGroup(0, a[0].bg, [a[1]]); uniDirty = true; boundU = null;
              if (!curTBG) { curTBG = textureBindGroup(0); pass.setBindGroup(1, curTBG); }
              pass.setViewport(0, 0, W, H, 0, 1); vpDirty = true;   // glClear ignores the viewport
              setScissor();
              pass.draw(3);
            }
            c += 2; break;
          }
          case 16: st.dnear = F[c + 1]; st.dfar = F[c + 2]; vpDirty = true; c += 3; break;
          case 17: st.unit = (I[c + 1] - G.TEXTURE0) & 3; c += 2; break;
          case 18:                                                             // BINDTEX: first use creates the entry
            if (I[c + 2] && !texs[I[c + 2]]) texs[I[c + 2]] = newTex();
            st.bound[st.unit] = I[c + 2]; texDirty = true; c += 3; break;
          case 19: case 20: {                                                  // TEXPARAMI / TEXPARAMF
            var t = texs[st.bound[st.unit]], pn = I[c + 2], v = I[c] === 19 ? I[c + 3] : F[c + 3];
            if (t) {
              if (pn === G.MIN_FILTER) t.params.min = v; else if (pn === G.MAG_FILTER) t.params.mag = v;
              else if (pn === G.WRAP_S) t.params.ws = v; else if (pn === G.WRAP_T) t.params.wt = v;
              else if (pn === G.MAX_ANISO) t.params.aniso = v;
              t.samp = null; texDirty = true;
            }
            c += 4; break;
          }
          case 21: { var td = texs[I[c + 1]]; if (td && td.tex) td.tex.destroy(); texs[I[c + 1]] = null; texDirty = true; c += 2; break; }
          case 22: st.prog = I[c + 1]; pipeDirty = texDirty = uniDirty = true; c += 2; break;
          case 23: c += 3; break;                                              // UNIFORM1I: samplers are fixed
          case 24: case 25: case 26: {                                         // UNIFORM1F / 4F / MAT4
            var ul = ulocs[I[c + 1]], cnt = I[c] === 24 ? 1 : I[c] === 25 ? 4 : 16;
            if (ul && ul !== -1) { progs[ul.p].shadow.set(F.subarray(c + 2, c + 2 + cnt), ul.off); if (ul.p === st.prog) uniDirty = true; }
            c += 2 + cnt; break;
          }
          case 27: st.attrOn |= 1 << I[c + 1]; pipeDirty = true; c += 2; break;
          case 28: st.attrOn &= ~(1 << I[c + 1]); pipeDirty = true; c += 2; break;
          case 29: st.attrConst.set(F.subarray(c + 2, c + 6), I[c + 1] * 4); uniDirty = true; c += 6; break;
          case 30: {                                                           // ATTRIB_PTR l size type norm stride off
            var at = st.attr[I[c + 1]];
            if (at.size !== I[c + 2] || at.type !== I[c + 3] || at.norm !== I[c + 4] || at.stride !== I[c + 5]) {
              at.size = I[c + 2]; at.type = I[c + 3]; at.norm = I[c + 4]; at.stride = I[c + 5]; pipeDirty = true;
            }
            at.off = sb[I[c + 1]] + I[c + 6];
            c += 7; break;
          }
          case 31: {                                                           // DRAW_ELEMENTS mode count type off
            var mode = I[c + 1], count = I[c + 2], type = I[c + 3], off = I[c + 4];
            var ifmt = type === G.UNSIGNED_INT ? 'uint32' : type === G.UNSIGNED_SHORT ? 'uint16' : null;
            if (mode === 6 || mode === 2 || !ifmt) {
              // fans, loops and 8-bit indices: expand into generated 32-bit indices
              var src = [], k;
              for (k = 0; k < count; k++) src.push(type === G.UNSIGNED_INT ? HEAPU32[(ip + off >> 2) + k] : type === G.UNSIGNED_SHORT ? HEAPU16[(ip + off >> 1) + k] : HEAPU8[ip + off + k]);
              if (mode === 6) { var fl = []; for (k = 1; k + 1 < count; k++) fl.push(src[0], src[k], src[k + 1]); drawGen('triangle-list', fl); }
              else if (mode === 2) { src.push(src[0]); drawGen('line-strip', src); }
              else drawGen(TOPO[mode], src);
            } else if (TOPO[mode] && prep(TOPO[mode], (mode === 3 || mode === 5) ? ifmt : undefined)) {
              if (lastIdx !== ifmt) { pass.setIndexBuffer(ibuf.buf, ifmt); lastIdx = ifmt; }
              pass.drawIndexed(count, 1, off / (ifmt === 'uint32' ? 4 : 2));
            }
            c += 5; break;
          }
          case 32:                                                             // DRAW_QUADS count off
            if (prep('triangle-list')) { pass.setIndexBuffer(qbuf, 'uint32'); lastIdx = null; pass.drawIndexed(I[c + 1], 1, I[c + 2] / 4); }
            c += 3; break;
          case 33: {                                                           // DRAW_ARRAYS mode first count
            var m = I[c + 1], first = I[c + 2], cn = I[c + 3], q, li = [];
            if (m === 6) { for (q = 1; q + 1 < cn; q++) li.push(first, first + q, first + q + 1); drawGen('triangle-list', li); }
            else if (m === 2) { for (q = 0; q < cn; q++) li.push(first + q); li.push(first); drawGen('line-strip', li); }
            else if (TOPO[m] && prep(TOPO[m])) pass.draw(cn, 1, first);
            c += 4; break;
          }
          case 34:                                                             // TEXIMAGE (data in the data arena)
            splitForUpload();
            api.texUpload(I[c + 1], I[c + 2], I[c + 3], I[c + 4], I[c + 5], I[c + 6], I[c + 7], I[c + 8], I[c + 9],
                         I[c + 10] >= 0 ? dp + I[c + 10] : 0, I[c + 11]);
            texDirty = true;
            c += 12; break;
          case 35: c += 3; break;                                              // PIXELSTORE: n/a
          case 38: {                                                           // NEWPROG h key vsOff vsLen fsOff:
            var ph = I[c + 1];                                                 // the replayer keys off the key, not the source
            if (!progs[ph]) progs[ph] = { key: I[c + 2] >>> 0, shadow: new Float32Array(120), modules: {} };
            c += 7; break; }
          case 39: {                                                           // NEWULOC h prog nameOff nameLen
            var lh = I[c + 1];
            if (ulocs[lh] === undefined) {                                   // name: strdup'ed, absolute address
              var nso = I[c + 3] >>> 0, b = new Uint8Array(I[c + 4] - 1);
              b.set(HEAPU8.subarray(nso, nso + I[c + 4] - 1));
              var o = UNIFORM_OFF[new TextDecoder().decode(b)];
              ulocs[lh] = o ? { p: I[c + 2], off: o[0], n: o[1] } : -1;
            }
            c += 5; break; }
          case 37: {                                                           // DEPTHPROBE: not implemented here yet,
            var pn = I[c + 1], pr = I[c + 2] >> 2;                             // so every point is visible (as before)
            for (var pk = 0; pk < pn; pk++) HEAP32[pr + I[c + 3 + 4 * pk]] = 1;
            c += 3 + 4 * pn; break;
          }
          // GPU model animation (OP_GA_*): WebGL2 only; GpuAnim.cpp doesn't record them for this
          // replayer (the CPU path draws the models), skipped here just in case
          case 40: c += 3; break;
          case 41: c += 6; break;
          case 42: c += 7; break;
          case 43: c += 30 + 4 * I[c + 29]; break;
          case 44: c += 2; break;
          case 45: case 46: c += 5; break;                                    // WORLDEND marker (post chain: WebGL2 only)
          case 36: {                                                           // VSTREAMS (ptr len) x6
            var tot = 0, k;
            for (k = 0; k < 6; k++) { sb[k] = tot; tot += (I[c + 2 + 2 * k] + 15) & ~15; }
            if (tot && vbuf.ensure(tot)) vbOff = [-1, -1, -1, -1, -1, -1];   // new buffer: rebind
            for (k = 0; k < 6; k++) {
              var sp = I[c + 1 + 2 * k] >>> 0, sn = I[c + 2 + 2 * k];
              if (sn) dev.queue.writeBuffer(vbuf.buf, sb[k], HEAPU8, sp, (sn + 3) & ~3);
            }
            c += 13; break;
          }
          default:
            console.error('se1gfx webgpu replay: bad opcode ' + I[c]);
            c = end;
          }
        }
        pass.end();
        upool.finish(); xpool.finish();   // queue.writeBuffer before submit: ordered before these draws
        dev.queue.submit([enc.finish()]);
      }
    };
    Module['se1GfxSync'] = sync;
    return api;
  }
})();
