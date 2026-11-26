"""Tira del skyline de Loja (dibujo de un solo tono sobre blanco) -> webp para la capa "city" de la portada.

El tono del dibujo se vuelve opacidad: el blanco queda transparente y todo lo dibujado toma el color de la capa, con sus
bordes suaves. Se recorta el cielo vacío de arriba y el blanco de los costados y de abajo (el suelo queda en el borde).
Uso: python herramientas/skyline.py imagenes/loja-skyline-1.png public/img/portada/loja-skyline-1.webp [alto_px]
"""
import sys
import numpy as np
from PIL import Image

COLOR = (0xcf, 0xd8, 0xe2)  # el gris azulado del modelo

src, dst = sys.argv[1], sys.argv[2]
height = int(sys.argv[3]) if len(sys.argv) > 3 else 360
rgb = np.asarray(Image.open(src).convert('RGB')).astype(float)
lum = rgb @ [0.3, 0.59, 0.11]
fill = np.percentile(lum[lum < 245], 30) if (lum < 245).any() else 200  # el tono de las siluetas
alpha = np.clip((255 - lum) / max(1, 255 - fill), 0, 1)
alpha[alpha < 0.04] = 0
rows = np.where(alpha.max(1) > 0.3)[0]
cols = np.where(alpha.max(0) > 0.3)[0]
top, bottom = rows.min(), rows.max() + 1
left, right = cols.min(), cols.max() + 1
out = np.zeros(rgb.shape[:2] + (4,), np.uint8)
out[..., :3] = COLOR
out[..., 3] = (alpha * 255).round()
im = Image.fromarray(out).crop((left, top, right, bottom))
w = round(im.width * height / im.height)
im.resize((w, height), Image.LANCZOS).save(dst, quality=90, method=6)
print(f'{dst}: {w}x{height} (recorte {right - left}x{bottom - top}, tono {fill:.0f})')
