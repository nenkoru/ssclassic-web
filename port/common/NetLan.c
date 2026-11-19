/* Virtual LAN for browser multiplayer (linked with -Wl,--wrap= for socket, bind, sendto, recvfrom,
 * fcntl, close, gethostname, gethostbyname).
 *
 * The engine talks UDP (Engine/Network/CommunicationInterface.cpp): one socket, non-blocking
 * sendto/recvfrom. In the browser that socket is virtual. Each packet goes into an outbound byte
 * ring in wasm memory; the page's main thread (port/web/net.js) sends it over a WebSocket to the
 * LAN switch (rust/se1-server), which forwards it to the browser that owns the destination's
 * virtual address (10.77.0.x). Packets for us come back the same way into an inbound ring. No call
 * blocks or proxies to the main thread, so the threaded build's engine worker never waits.
 *
 * Only active when the page joined a room (?room=..., see port/web/pre.js); otherwise every call
 * goes straight to libc/Emscripten.
 */
#include <emscripten.h>
#include <emscripten/atomic.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#ifdef SE1_THREADS
#include <emscripten/threading.h>
#endif

int __real_socket(int, int, int);
int __real_bind(int, const struct sockaddr *, socklen_t);
ssize_t __real_sendto(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
ssize_t __real_recvfrom(int, void *, size_t, int, struct sockaddr *, socklen_t *);
int __real_fcntl(int, int, ...);
int __real_close(int);
int __real_gethostname(char *, size_t);
struct hostent *__real_gethostbyname(const char *);

#define LAN_FD 0x4E54           /* the virtual socket's descriptor ("NT") */
#define RING (1u << 20)         /* bytes per ring */
#define HDR 8                   /* [ip u32][src port u16][dst port u16], big-endian */

/* shared with port/web/net.js: [0] out write, [1] out read, [2] in write, [3] in read (byte
   counters, wrapping), [4] packets sent, [5] packets received, [6] dropped (ring full) */
static int32_t _ctl[8];
static uint8_t _out[RING], _in[RING];
EMSCRIPTEN_KEEPALIVE int32_t *SE1_NetLan_Ctl(void) { return _ctl; }
EMSCRIPTEN_KEEPALIVE uint8_t *SE1_NetLan_Out(void) { return _out; }
EMSCRIPTEN_KEEPALIVE uint8_t *SE1_NetLan_In(void) { return _in; }

static int _state = -1;          /* -1 unknown, 0 off, 1 on */
static uint32_t _myIp;           /* host order */
static uint16_t _myPort;
static int _open;

static int lan_on(void) {
  if (_state < 0) {
#ifdef SE1_THREADS
    double ip = MAIN_THREAD_EM_ASM_DOUBLE({ return Module.se1NetIp || 0; });
#else
    double ip = EM_ASM_DOUBLE({ return Module.se1NetIp || 0; });
#endif
    _myIp = (uint32_t)ip;
    _state = _myIp != 0;
  }
  return _state;
}

static uint32_t rd(int i) { return emscripten_atomic_load_u32((void *)&_ctl[i]); }
static void wr(int i, uint32_t v) { emscripten_atomic_store_u32((void *)&_ctl[i], v); }

static void ring_put(uint8_t *ring, uint32_t at, const uint8_t *p, uint32_t n) {
  for (uint32_t k = 0; k < n; k++) ring[(at + k) & (RING - 1)] = p[k];
}
static void ring_get(const uint8_t *ring, uint32_t at, uint8_t *p, uint32_t n) {
  for (uint32_t k = 0; k < n; k++) p[k] = ring[(at + k) & (RING - 1)];
}

int __wrap_socket(int domain, int type, int protocol) {
  if (domain == AF_INET && (type & 0xf) == SOCK_DGRAM && lan_on()) {
    if (_open) { errno = EMFILE; return -1; }   /* the engine opens one socket at a time */
    _open = 1; _myPort = 0;
    return LAN_FD;
  }
  return __real_socket(domain, type, protocol);
}

int __wrap_bind(int fd, const struct sockaddr *addr, socklen_t len) {
  if (fd != LAN_FD) return __real_bind(fd, addr, len);
  const struct sockaddr_in *sin = (const struct sockaddr_in *)addr;
  _myPort = ntohs(sin->sin_port);
  if (!_myPort) _myPort = (uint16_t)(40000 + (_myIp & 0xff));   /* "any port": unique per peer in a room */
  return 0;
}

ssize_t __wrap_sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *addr, socklen_t alen) {
  if (fd != LAN_FD) return __real_sendto(fd, buf, len, flags, addr, alen);
  if (!addr || len > 4096) { errno = EINVAL; return -1; }
  const struct sockaddr_in *sin = (const struct sockaddr_in *)addr;
  if (!_myPort) _myPort = 40000 + (uint16_t)(_myIp & 0xff);
  uint32_t total = HDR + (uint32_t)len, w = rd(0), r = rd(1);
  if (RING - (w - r) < total + 2) { wr(6, rd(6) + 1); return (ssize_t)len; }   /* full: drop, like UDP */
  uint8_t h[2 + HDR];
  uint32_t dst = ntohl(sin->sin_addr.s_addr);
  uint16_t dport = ntohs(sin->sin_port);
  h[0] = (uint8_t)(total >> 8); h[1] = (uint8_t)total;
  h[2] = dst >> 24; h[3] = dst >> 16; h[4] = dst >> 8; h[5] = dst;
  h[6] = _myPort >> 8; h[7] = (uint8_t)_myPort; h[8] = dport >> 8; h[9] = (uint8_t)dport;
  ring_put(_out, w, h, sizeof(h));
  ring_put(_out, w + sizeof(h), buf, (uint32_t)len);
  wr(0, w + 2 + total);   /* publish after the data */
  wr(4, rd(4) + 1);
  return (ssize_t)len;
}

ssize_t __wrap_recvfrom(int fd, void *buf, size_t len, int flags, struct sockaddr *addr, socklen_t *alen) {
  if (fd != LAN_FD) return __real_recvfrom(fd, buf, len, flags, addr, alen);
  for (;;) {
    uint32_t w = rd(2), r = rd(3);
    if (w == r) { errno = EWOULDBLOCK; return -1; }
    uint8_t h[2 + HDR];
    ring_get(_in, r, h, sizeof(h));
    uint32_t total = ((uint32_t)h[0] << 8) | h[1];
    uint32_t n = total - HDR;
    uint16_t dport = (uint16_t)((h[8] << 8) | h[9]);
    if (dport != _myPort || total < HDR) { wr(3, r + 2 + total); continue; }   /* not for our port */
    uint32_t src = ((uint32_t)h[2] << 24) | ((uint32_t)h[3] << 16) | ((uint32_t)h[4] << 8) | h[5];
    uint16_t sport = (uint16_t)((h[6] << 8) | h[7]);
    uint32_t copy = n < len ? n : (uint32_t)len;
    ring_get(_in, r + sizeof(h), buf, copy);
    wr(3, r + 2 + total);
    wr(5, rd(5) + 1);
    if (addr && alen && *alen >= (socklen_t)sizeof(struct sockaddr_in)) {
      struct sockaddr_in *sin = (struct sockaddr_in *)addr;
      memset(sin, 0, sizeof(*sin));
      sin->sin_family = AF_INET; sin->sin_port = htons(sport); sin->sin_addr.s_addr = htonl(src);
      *alen = sizeof(struct sockaddr_in);
    }
    return (ssize_t)copy;
  }
}

int __wrap_fcntl(int fd, int cmd, ...) {
  va_list ap; va_start(ap, cmd); long arg = va_arg(ap, long); va_end(ap);
  if (fd == LAN_FD) return cmd == F_GETFL ? O_RDWR | O_NONBLOCK : 0;
  return __real_fcntl(fd, cmd, arg);
}

int __wrap_close(int fd) {
  if (fd == LAN_FD) { _open = 0; _myPort = 0; return 0; }
  return __real_close(fd);
}

int __wrap_gethostname(char *name, size_t len) {
  if (lan_on()) { snprintf(name, len, "se1-lan"); return 0; }
  return __real_gethostname(name, len);
}

struct hostent *__wrap_gethostbyname(const char *name) {
  if (!lan_on()) return __real_gethostbyname(name);
  static uint32_t addr;
  static char *list[2];
  static struct hostent he;
  if (strcmp(name, "se1-lan") && strcmp(name, "localhost")) { h_errno = HOST_NOT_FOUND; return NULL; }
  addr = htonl(_myIp);
  list[0] = (char *)&addr; list[1] = NULL;
  he.h_name = (char *)name; he.h_aliases = NULL; he.h_addrtype = AF_INET; he.h_length = 4; he.h_addr_list = list;
  return &he;
}

/* last octet of this browser's virtual address (10.77.0.x), 0 when not in a room */
int SE1_NetLan_IpLow(void);
int SE1_NetLan_IpLow(void) { return lan_on() ? (int)(_myIp & 0xff) : 0; }
