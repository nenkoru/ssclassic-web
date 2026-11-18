/* Web (Emscripten) replacement for Engine/Base/Unix/UnixDynamicLoader.cpp.
 * There is no dlopen in a single wasm module: every "library" the engine asks
 * for (Entities, Game, Shaders, vorbisfile, ...) is linked in statically and its
 * exports are looked up by name in a generated table (port/<game>/static_symbols.cpp).
 */
#include <Engine/Engine.h>
#include <Engine/Base/DynamicLoader.h>

extern "C" void *SE1_FindStaticSymbol(const char *name);

class CWebDynamicLoader : public CDynamicLoader
{
public:
  CWebDynamicLoader(const char *libname) : err(NULL) {
    // Libraries we don't ship (e.g. amp11lib for MP3) report an error so the
    // engine disables that feature, exactly as when the .so is missing.
    if (libname != NULL) {
      CTFileName fnm = CTString(libname);
      CTString base = fnm.FileName();
      const char *b = (const char *)base;
      if (strcasecmp(b, "vorbisfile") && strcasecmp(b, "libvorbisfile") && strcasecmp(b, "vorbisidec")) {
        SetError(CTString("library '") + libname + "' is not available in the web build");
      }
    }
  }
  virtual ~CWebDynamicLoader(void) { delete err; }

  virtual void *FindSymbol(const char *sym) {
    void *p = SE1_FindStaticSymbol(sym);
    if (p == NULL) {
      SetError(CTString("symbol '") + sym + "' not in static registry");
    } else {
      delete err; err = NULL;
    }
    return p;
  }
  virtual const char *GetError(void) { return err ? (const char *)*err : NULL; }

private:
  void SetError(const CTString &str) {
    delete err;
    err = new CTString(str);
    CPrintF("CWebDynamicLoader: %s\n", (const char *)str);
  }
  CTString *err;
};

CDynamicLoader *CDynamicLoader::GetInstance(const char *libname)
{
  return new CWebDynamicLoader(libname);
}

CTFileName CDynamicLoader::ConvertLibNameToPlatform(const char *libname)
{
  return CTFileName(CTString(libname));
}
