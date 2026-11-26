"""Fondo de cerros de Loja (dibujo de ChatGPT en dos tonos sobre blanco) -> webp con el cielo transparente, y la
posición de los 11 aerogeneradores del Villonaco sobre su cresta, para pegar en TURBINES de public/js/escena.js.

El Villonaco es el plano de adelante (el tono más oscuro): se busca su borde de arriba y los aerogeneradores se
reparten por el tramo de cresta más alto. Las coordenadas salen en unidades de la escena, con el dibujo ubicado como lo
ubica escena.js (alto H, ancho 3·H, centrado en una escena de 1600 de ancho, arriba en Y).
Uso: python herramientas/montanas.py imagenes/loja-montanas.png public/img/portada/loja-montanas.webp [H] [Y] [DX]
"""
import json
import sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

src, dst = sys.argv[1], sys.argv[2]
H = float(sys.argv[3]) if len(sys.argv) > 3 else 330
Y = float(sys.argv[4]) if len(sys.argv) > 4 else 170
DX = float(sys.argv[5]) if len(sys.argv) > 5 else 0  # corrimiento horizontal del dibujo en la escena
W_SCENE, N = 1600, 11

im = Image.open(src).convert('RGB')
a = np.asarray(im).astype(int)
h, w = a.shape[:2]
lum = a @ [0.3, 0.59, 0.11]
white = (a.min(-1) > 244) & ((a.max(-1) - a.min(-1)) < 10)
lab, _ = ndimage.label(white)
edge = set(np.unique(lab[0])) | set(np.unique(lab[:, 0])) | set(np.unique(lab[:, -1]))
edge.discard(0)
sky = np.isin(lab, list(edge))

# el dibujo queda a 3:1 (como lo ubica escena.js); si viene de otra proporción, se recorta o se completa abajo
alpha = Image.fromarray(np.where(sky, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
rgba = im.copy()
rgba.putalpha(alpha)
out_h = round(w / 3)
canvas = Image.new('RGBA', (w, out_h), (0, 0, 0, 0))
canvas.alpha_composite(rgba.crop((0, max(0, h - out_h), w, h)), (0, max(0, out_h - h)))
canvas.save(dst, quality=88, method=6)

# el plano de adelante (Villonaco): el tono más oscuro de lo que no es cielo
ground = lum[~sky]
dark = lum < (np.percentile(ground, 20) + np.percentile(ground, 80)) / 2
dark &= ~sky
dark = ndimage.binary_opening(dark, iterations=2)
off = max(0, out_h - h) - max(0, h - out_h)  # corrimiento vertical por el recorte o el relleno
tops = np.array([np.argmax(dark[:, x]) if dark[:, x].any() else h for x in range(w)], float) + off
left = tops[: w // 2]
peak = int(np.argmin(left))
crest = np.where(left <= left[peak] + out_h * 0.09)[0]  # el tramo de cresta más alto
x0, x1 = crest.min(), crest.max()
s = H / out_h  # unidades de la escena por px
ox = (W_SCENE - 3 * H) / 2 + DX
turbines = []
for i in range(N):
    px = int(x0 + (x1 - x0) * (i + 0.5) / N)
    py = tops[max(0, px - 2): px + 3].max() + 2  # el pie, apenas dentro del cerro
    turbines.append([round(ox + px * s, 1), round(Y + py * s, 1), 30])
print(f'{dst}: {w}x{out_h}; cresta del Villonaco x {x0}-{x1} px, cumbre y {left[peak]:.0f}')
print('const TURBINES =', json.dumps(turbines))
