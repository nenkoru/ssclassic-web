#!/usr/bin/env python3
"""Split a data folder into a boot bundle (data-boot) and lazy files (gamedata).

See notes/lazy-data.md, section 1.

BOOT files (small, or under Nav/ SE1Mod/) become hard links in data-boot.
LAZY files (>= threshold, elsewhere) become 0-byte placeholders in data-boot
and hard links in gamedata. A manifest.txt lists the lazy files.
"""

import argparse
import hashlib
import os
import shutil
import sys

BOOT_EXEMPT = ("nav", "se1mod")
DEFAULT_THRESHOLD = 262144


def _key(relpath, size, mtime_ns):
    return hashlib.sha1(f"{relpath}\0{size}\0{mtime_ns}".encode()).hexdigest()[:16]


def _link(src, dst):
    """Hard link src->dst; fall back to copy2 across devices."""
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def _link_ok(src_st, dst_st):
    if src_st.st_dev == dst_st.st_dev and src_st.st_ino == dst_st.st_ino:
        return True
    return src_st.st_size == dst_st.st_size and src_st.st_mtime_ns == dst_st.st_mtime_ns


def _write_if_changed(path, text):
    if os.path.isfile(path):
        with open(path, "rb") as f:
            if f.read() == text.encode():
                return
    with open(path, "w") as f:
        f.write(text)


def stage(data_dir, out_dir, threshold=DEFAULT_THRESHOLD):
    data_dir = os.path.abspath(data_dir)
    boot_dir = os.path.join(out_dir, "data-boot")
    lazy_dir = os.path.join(out_dir, "gamedata")

    lazy = []  # (relpath, size, key)
    boot = []  # relpaths
    src_files = {}  # relpath -> src path
    src_dirs = set()  # relpaths of every source directory (mirrored in data-boot, even empty)

    for root, dirs, files in os.walk(data_dir, topdown=True):
        dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(root, d)))
        for d in dirs:
            src_dirs.add(os.path.relpath(os.path.join(root, d), data_dir).replace(os.sep, "/"))
        for name in sorted(files):
            if name == ".DS_Store":
                continue
            src = os.path.join(root, name)
            if os.path.islink(src) and not os.path.isfile(src):
                continue
            rel = os.path.relpath(src, data_dir).replace(os.sep, "/")
            st = os.stat(src)
            first = rel.split("/", 1)[0].lower()
            is_lazy = st.st_size >= threshold and first not in BOOT_EXEMPT
            src_files[rel] = (src, st, is_lazy)

    boot_produced = set()
    lazy_produced = set()

    # data-boot: mirror directories, then files.
    for rel in src_dirs:
        os.makedirs(os.path.join(boot_dir, rel), exist_ok=True)
    for rel, (src, st, is_lazy) in src_files.items():
        dst = os.path.join(boot_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if is_lazy:
            # placeholder: 0 bytes, source mtime
            if os.path.isfile(dst):
                dst_st = os.lstat(dst)
                if dst_st.st_size == 0 and dst_st.st_mtime_ns == st.st_mtime_ns:
                    lazy.append((rel, st.st_size, _key(rel, st.st_size, st.st_mtime_ns)))
                    boot_produced.add(rel)
                    continue
                os.remove(dst)
            with open(dst, "wb"):
                pass
            os.utime(dst, ns=(st.st_atime_ns, st.st_mtime_ns))
            lazy.append((rel, st.st_size, _key(rel, st.st_size, st.st_mtime_ns)))
        else:
            if os.path.isfile(dst) and _link_ok(st, os.lstat(dst)):
                boot.append(rel)
                boot_produced.add(rel)
                continue
            if os.path.lexists(dst):
                os.remove(dst)
            _link(src, dst)
            boot.append(rel)
        boot_produced.add(rel)

    # gamedata: links for lazy files.
    for rel, (src, st, is_lazy) in src_files.items():
        if not is_lazy:
            continue
        dst = os.path.join(lazy_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.isfile(dst) and _link_ok(st, os.lstat(dst)):
            lazy_produced.add(rel)
            continue
        if os.path.lexists(dst):
            os.remove(dst)
        _link(src, dst)
        lazy_produced.add(rel)

    # manifest
    lazy.sort(key=lambda t: t[0])
    lines = [f"{key} {size} {rel}" for rel, size, key in lazy]
    dataset = hashlib.sha1("\n".join(lines).encode()).hexdigest()[:16]
    manifest = "dataset " + dataset + "\n" + "\n".join(lines) + ("\n" if lines else "")

    for mpath in (os.path.join(boot_dir, "SE1Lazy", "manifest.txt"),
                  os.path.join(lazy_dir, "manifest.txt")):
        os.makedirs(os.path.dirname(mpath), exist_ok=True)
        _write_if_changed(mpath, manifest)
    boot_produced.add("SE1Lazy/manifest.txt")
    lazy_produced.add("manifest.txt")

    # stale removal
    for d, keep in ((boot_dir, boot_produced), (lazy_dir, lazy_produced)):
        for root, dirs, files in os.walk(d, topdown=False):
            for name in files:
                rel = os.path.relpath(os.path.join(root, name), d).replace(os.sep, "/")
                if rel not in keep:
                    os.remove(os.path.join(root, name))
            for name in dirs:
                p = os.path.join(root, name)
                if d == boot_dir and os.path.relpath(p, d).replace(os.sep, "/") in src_dirs:
                    continue
                try:
                    os.rmdir(p)
                except OSError:
                    pass  # non-empty, or a data-boot dir that mirrors the source

    return {
        "lazy": [(rel, size, key) for rel, size, key in lazy],
        "boot": sorted(boot),
        "dataset": dataset,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD)
    args = ap.parse_args(argv)

    if not os.path.isdir(args.data):
        print(f"lazydata: data dir not found: {args.data}", file=sys.stderr)
        return 2

    res = stage(args.data, args.out, args.threshold)
    lz_bytes = sum(s for _, s, _ in res["lazy"])
    boot_bytes = sum(
        os.path.getsize(os.path.join(args.data, rel)) for rel in res["boot"]
    )
    print(
        f"lazydata: {len(res['lazy'])} lazy files ({lz_bytes / 1e6:.1f} MB) -> gamedata/, "
        f"{len(res['boot'])} boot files ({boot_bytes / 1e6:.1f} MB) -> data-boot/, "
        f"dataset {res['dataset']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
