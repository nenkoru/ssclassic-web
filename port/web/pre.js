// Runs before the engine module starts (linked with --pre-js).
// ?args=+script%20SE1Mod/bench.ini  ->  engine command line "+script SE1Mod/bench.ini"
// ?bench=1                          ->  shorthand for the demo benchmark
(function () {
  var q = new URLSearchParams(location.search);
  var args = [];
  if (q.get('bench')) args.push('+script', 'SE1Mod/bench.ini');
  if (q.get('args')) args = args.concat(q.get('args').split(' ').filter(Boolean));
  if (args.length) Module['arguments'] = args;
  if (q.get('uncapped') === '1') Module['se1Uncapped'] = true;   // timedemo: no vsync wait (port/common/WebFrame.cpp)
})();

// Windows file-name semantics: Croteam's code, scripts and every community mod assume
// case-insensitive paths ("demos\x.dem" for "Demos/x.dem"). Emscripten resolves every path
// component through FS.lookupNode; when the exact name is missing, fall back to a
// case-insensitive match in that directory. Exact matches stay the fast path.
Module['preRun'] = (Module['preRun'] || []).concat([function () {
  var lookupNode = FS.lookupNode;
  FS.lookupNode = function (parent, name) {
    try {
      return lookupNode.call(FS, parent, name);
    } catch (e) {
      if (!(e instanceof FS.ErrnoError) || e.errno !== 44 /* ENOENT */) throw e;
      var contents = parent && parent.contents, lower = name.toLowerCase();
      if (contents && typeof contents === 'object' && !ArrayBuffer.isView(contents)) {
        for (var k in contents) {
          if (k.toLowerCase() === lower) return lookupNode.call(FS, parent, k);
        }
      }
      throw e;
    }
  };
}]);
