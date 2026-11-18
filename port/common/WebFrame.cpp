/* Hand control back to the browser once per presented frame.
 *
 * The engine's main loop (and its level-loading progress hook) never returns to the browser.
 * With JSPI, blocking calls can suspend the wasm stack: we await the next animation frame
 * after every buffer swap, so Chrome presents the frame we just drew (including loading
 * screens), runs input/audio events, and paces us to vsync. The race with a short timeout
 * keeps loading moving when rAF is throttled (hidden tab).
 */
#include <emscripten.h>

EM_ASYNC_JS(void, se1_wait_frame, (void), {
  await new Promise(function(resolve) {
    var done = false;
    var finish = function() { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(finish);
    setTimeout(finish, 100);
  });
});

#ifdef SE1_WITH_RUSTMOD
void SE1Mod_Frame(void);  // port/common/Se1ModHost.cpp
#endif

extern "C" void SE1_YieldToBrowser(void)
{
#ifdef SE1_WITH_RUSTMOD
  SE1Mod_Frame();
#endif
  se1_wait_frame();
}
