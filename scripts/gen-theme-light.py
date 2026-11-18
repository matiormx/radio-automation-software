"""Genera src/theme-light.css: variables del modo claro y, para cada regla con
# Uso: python3 scripts/gen-theme-light.py src/styles.css src/theme-light.css (luego se añaden a mano los retoques del final)
colores fijos oscuros/claros, su versión invertida en luminosidad."""
import re, sys, colorsys
src = open(sys.argv[1]).read()
src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)

def parse(css):
    """(prelude_stack, selector, decls) para cada regla, con @media anidado."""
    out = []; i = 0; stack = []
    buf = ""
    while i < len(css):
        c = css[i]
        if c == "{":
            head = buf.strip(); buf = ""
            if head.startswith("@media") or head.startswith("@supports"):
                stack.append(head); i += 1; continue
            if head.startswith("@keyframes") or head.startswith("@font-face"):
                depth = 1; i += 1
                while depth and i < len(css):
                    depth += css[i] == "{"; depth -= css[i] == "}"; i += 1
                continue
            j = css.index("}", i)
            out.append((list(stack), head, css[i+1:j])); i = j + 1; continue
        if c == "}":
            if stack: stack.pop()
            buf = ""; i += 1; continue
        buf += c; i += 1
    return out

def hex2rgb(h):
    h = h.lstrip("#")
    if len(h) in (3, 4): h = "".join(x*2 for x in h[:3]) + (h[3]*2 if len(h) == 4 else "")
    r, g, b = (int(h[k:k+2], 16) / 255 for k in (0, 2, 4))
    a = int(h[6:8], 16) / 255 if len(h) == 8 else None
    return r, g, b, a

def flip(r, g, b, role):
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if s > 0.45 and 0.35 < l < 0.75:
        # color de marca/estado: se oscurece un poco si es texto
        if role == "fg": l = max(0.28, l - 0.18)
        return colorsys.hls_to_rgb(h, l, s)
    l2 = 1 - l
    if role == "bg": l2 = 0.86 + (l2 - 0.5) * 0.28 if l < 0.5 else l2
    if role == "fg": l2 = min(l2, 0.42) if l > 0.5 else l2
    return colorsys.hls_to_rgb(h, l2, s * 0.7)

def conv_hex(m, role):
    r, g, b, a = hex2rgb(m.group(0))
    r, g, b = flip(r, g, b, role)
    out = "#%02x%02x%02x" % tuple(round(x * 255) for x in (r, g, b))
    if a is not None: out += "%02x" % round(a * 255)
    return out

def conv_rgba(m, role):
    r, g, b = (int(x) / 255 for x in m.group(1, 2, 3)); a = m.group(4)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if s > 0.45 and 0.35 < l < 0.75: return m.group(0)
    r, g, b = flip(r, g, b, role)
    vals = ",".join(str(round(x * 255)) for x in (r, g, b))
    return f"rgba({vals},{a})" if a else f"rgb({vals})"

ROLE = {"color": "fg", "fill": "fg", "stroke": "fg", "caret-color": "fg"}
COLOR = re.compile(r"#[0-9a-fA-F]{3,8}\b")
RGBA = re.compile(r"rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)")
out = []
for stack, sel, body in parse(src):
    if sel.startswith(":root"): continue
    decls = []
    for d in body.split(";"):
        if ":" not in d: continue
        prop, val = d.split(":", 1); prop = prop.strip(); val = val.strip()
        if prop.startswith("--") or not (COLOR.search(val) or RGBA.search(val)): continue
        if prop in ("box-shadow", "text-shadow", "filter"):
            # sombras: más suaves en claro
            nv = RGBA.sub(lambda m: f"rgba(0,0,0,{min(0.18, float(m.group(4) or 1))})", val)
            nv = COLOR.sub(lambda m: "#0000002a" if hex2rgb(m.group(0))[3] is not None else m.group(0), nv)
            if nv != val: decls.append(f"{prop}: {nv}")
            continue
        role = ROLE.get(prop, "bg")
        nv = COLOR.sub(lambda m: conv_hex(m, role), val)
        nv = RGBA.sub(lambda m: conv_rgba(m, role), nv)
        if nv != val: decls.append(f"{prop}: {nv}")
    if not decls: continue
    sels = ", ".join(f':root[data-theme="light"] {s.strip()}' for s in sel.split(","))
    rule = f"{sels} {{ {'; '.join(decls)}; }}"
    for st in reversed(stack): rule = f"{st} {{ {rule} }}"
    out.append(rule)

head = ''':root[data-theme="light"] {
  color-scheme: light;
  --bg: #eef1f5;
  --panel: #ffffff;
  --panel-2: #f3f5f8;
  --line: #d6dbe3;
  --line-strong: #b9c1cd;
  --text: #141a22;
  --text-dim: #3f4a5a;
  --text-faint: #5e6878;
  --accent: #2563eb;
  --accent-dim: #c7d7fb;
  --accent-soft: #2563eb1f;
  --live: #15913f;
  --warn: #b26a00;
  --danger: #d02626;
}
:root[data-theme="light"][data-contrast] { --text: #05080c; --text-dim: #252e3a; --text-faint: #3d4757; }
'''
open(sys.argv[2], "w").write("/* Modo claro: generado a partir de styles.css (gen.py). */\n" + head + "\n".join(out) + "\n")
print(len(out), "reglas")
