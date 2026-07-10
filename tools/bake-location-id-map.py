"""One-off data-prep script (not part of the runtime app): converts the raw
locations.png (Paradox's artistic color choices - copyrighted, kept local
only, never committed/redistributed) into a derived ID-encoded PNG where each
pixel's R+G channels directly encode the location's numeric ID (matching the
same 1-based ordinal ID used by definitions.txt / the save format), and B
encodes whether it's worth treating as land vs the deep-ocean fill. This is a
pure data transformation (location topology only), not a copy of the game's
artwork, and is what the web app actually loads at runtime.
"""
import json
from PIL import Image
import numpy as np

Image.MAX_IMAGE_PIXELS = None

MAP_DATA = "map_data"

img = Image.open(f"{MAP_DATA}/locations.png").convert("RGB")
arr = np.array(img)
h, w, _ = arr.shape
print("source size:", w, h)

with open(f"{MAP_DATA}/locations.json", encoding="utf-8") as f:
    locations = json.load(f)

color_to_id = {}
for id_str, loc in locations.items():
    color_to_id[loc["color"]] = int(id_str)

packed = (arr[:, :, 0].astype(np.uint32) << 16) | (arr[:, :, 1].astype(np.uint32) << 8) | arr[:, :, 2].astype(np.uint32)
unique_colors = np.unique(packed)
print("unique colors in bitmap:", len(unique_colors))

# Vectorized color -> id lookup via a dense array indexed by packed RGB
# (24-bit space is 16M entries of uint16 = 32MB, fine for a one-off script).
lut = np.zeros(1 << 24, dtype=np.uint32)
missing = 0
for hexcolor, loc_id in color_to_id.items():
    lut[int(hexcolor, 16)] = loc_id
id_arr = lut[packed]
if (id_arr == 0).any():
    missing = int((id_arr == 0).sum())
    print(f"WARNING: {missing} pixels had no matching location id")

out = np.zeros((h, w, 3), dtype=np.uint8)
out[:, :, 0] = id_arr & 0xFF
out[:, :, 1] = (id_arr >> 8) & 0xFF
out[:, :, 2] = 0

out_img = Image.fromarray(out, mode="RGB")
out_img.save(f"{MAP_DATA}/location_ids.png", optimize=True)
print("wrote location_ids.png")
