#!/usr/bin/env python3
"""Prepara los plugins recomendados para MiRadio.

Por cada plugin: mira su última versión en GitHub, prueba los paquetes de
Windows y de Linux hasta encontrar los .vst3, y los vuelve a empaquetar como
<id>-<sistema>.zip (los .vst3 en la raíz). Escribe plugins.json con la versión
y la firma SHA-256 de cada paquete. Uso: mirror.py <carpeta de salida>
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile

# id -> repositorio (debe coincidir con el catálogo de src-tauri/src/vstpkg.rs)
# repo o (repo, etiqueta) si los plugins de DAW no están en la última versión
PLUGINS = {
    "lsp": "lsp-plugins/lsp-plugins",
    "airwindows": ("baconpaul/airwin2rack", "DAWPlugin"),
    "dragonfly": "michaelwillis/dragonfly-reverb",
    "zl-eq": "ZL-Audio/ZLEqualizer",
    "zl-comp": "ZL-Audio/ZLCompressor",
}

OS_WORDS = {
    "windows": ["windows", "win64", "win-x64", "win_x64", "-win", "_win", "win."],
    "linux": ["linux", "ubuntu", "-lin-", "_lin_"],
}
# PC normal de 64 bits (en Windows «win64» ya lo dice)
X64 = ["x86_64", "x86-64", "x64", "amd64", "win64"]
BAD = ["arm", "aarch64", "riscv", "i686", "i586", "i386", "x86_32", "win32", "32bit", "mac", "osx",
       "darwin", "freebsd", "debug", "src", "source", "dbg", "pdb", "-lv2", "lv2-", "ladspa", "-doc",
       "vcvplugin"]
ARCHIVES = (".zip", ".tar.gz", ".tgz", ".tar.xz", ".7z", ".msi")

TOKEN = os.environ.get("GH_TOKEN", "")


def notice(kind, msg):
    print(f"::{kind}::{msg}", flush=True)


def get(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": "MiRadio", "Accept": "application/vnd.github+json"})
    if TOKEN and "api.github.com" in url:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    return data if binary else json.loads(data)


def candidates(assets, os_name):
    out = []
    for a in assets:
        n = a["name"].lower()
        if not n.endswith(ARCHIVES):
            continue
        if not any(w in n for w in OS_WORDS[os_name]):
            continue
        if any(b in n for b in BAD):
            continue
        if not any(x in n for x in X64):
            continue
        score = (10 if "vst3" in n else 0)
        # Sin AVX2: funciona en cualquier PC (la diferencia de rendimiento es mínima)
        score += 0 if "avx" in n else 2
        # Mejor un comprimido que un instalador .msi
        score += 0 if n.endswith(".msi") else 1
        out.append((score, a))
    return [a for _, a in sorted(out, key=lambda t: -t[0])]


def extract(path, dest):
    n = path.lower()
    if n.endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            z.extractall(dest)
    elif n.endswith((".tar.gz", ".tgz", ".tar.xz")):
        with tarfile.open(path) as t:
            t.extractall(dest, filter="data")
    elif n.endswith(".msi"):
        # Se abre sin instalar (msitools): deja los archivos con sus carpetas
        os.makedirs(dest, exist_ok=True)
        subprocess.run(["msiextract", "-C", dest, path], check=True, stdout=subprocess.DEVNULL)
    elif n.endswith(".7z"):
        subprocess.run(["7z", "x", "-y", f"-o{dest}", path], check=True, stdout=subprocess.DEVNULL)


def find_vst3(root):
    """Bundles .vst3 (carpeta o archivo), sin entrar dentro de ellos."""
    found = []
    for cur, dirs, files in os.walk(root):
        for d in list(dirs):
            if d.lower().endswith(".vst3"):
                found.append(os.path.join(cur, d))
                dirs.remove(d)
        for f in files:
            if f.lower().endswith(".vst3"):
                found.append(os.path.join(cur, f))
    return found


def unpack_nested(root):
    """Paquetes dentro del paquete (un nivel): se abren en su sitio."""
    for cur, _, files in os.walk(root):
        for f in files:
            if f.lower().endswith(ARCHIVES):
                p = os.path.join(cur, f)
                try:
                    extract(p, p + ".d")
                except Exception:  # noqa: BLE001
                    pass


def zip_bundles(bundles, out_zip):
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for b in bundles:
            base = os.path.dirname(b)
            if os.path.isfile(b):
                z.write(b, os.path.basename(b))
                continue
            for cur, _, files in os.walk(b):
                for f in files:
                    full = os.path.join(cur, f)
                    info = zipfile.ZipInfo.from_file(full, os.path.relpath(full, base))
                    # Conserva el permiso de ejecución (las .so de Linux)
                    with open(full, "rb") as fh:
                        z.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "out"
    os.makedirs(out, exist_ok=True)
    list_only = bool(os.environ.get("LIST_ONLY"))
    manifest = {"updated": int(time.time()), "plugins": {}}
    for pid, repo in PLUGINS.items():
        repo, tag_name = repo if isinstance(repo, tuple) else (repo, None)
        try:
            url = f"https://api.github.com/repos/{repo}/releases/" + (f"tags/{tag_name}" if tag_name else "latest")
            rel = get(url)
        except Exception as e:  # noqa: BLE001
            notice("warning", f"{pid}: no se pudo consultar {repo}: {e}")
            continue
        tag = rel["tag_name"]
        if tag_name:
            # Publicación continua: la versión es la fecha del último archivo
            dates = sorted(a.get("updated_at", "") for a in rel.get("assets", []))
            tag = (dates[-1][:10] if dates and dates[-1] else tag)
        names = [a["name"] for a in rel.get("assets", [])]
        notice("notice", f"{pid} {tag}: {', '.join(names) or '(sin archivos)'}")
        if list_only:
            continue
        entry = {"version": tag, "repo": repo}
        for os_name in ("windows", "linux"):
            done = False
            for a in candidates(rel.get("assets", []), os_name):
                work = tempfile.mkdtemp()
                try:
                    pkg = os.path.join(work, a["name"])
                    with open(pkg, "wb") as f:
                        f.write(get(a["browser_download_url"], binary=True))
                    ex = os.path.join(work, "x")
                    extract(pkg, ex)
                    unpack_nested(ex)
                    bundles = find_vst3(ex)
                    if not bundles:
                        continue
                    name = f"{pid}-{os_name}.zip"
                    zip_bundles(bundles, os.path.join(out, name))
                    entry[os_name] = {
                        "file": name,
                        "sha256": sha256(os.path.join(out, name)),
                        "from": a["name"],
                        "bundles": [os.path.basename(b) for b in bundles],
                    }
                    notice("notice", f"{pid} {os_name}: {a['name']} -> {', '.join(entry[os_name]['bundles'])}")
                    done = True
                    break
                except Exception as e:  # noqa: BLE001
                    notice("warning", f"{pid} {os_name}: {a['name']}: {e}")
                finally:
                    shutil.rmtree(work, ignore_errors=True)
            if not done:
                notice("warning", f"{pid}: sin VST3 para {os_name} en {tag}")
        manifest["plugins"][pid] = entry
    if not list_only:
        with open(os.path.join(out, "plugins.json"), "w") as f:
            json.dump(manifest, f, indent=2)


if __name__ == "__main__":
    main()
