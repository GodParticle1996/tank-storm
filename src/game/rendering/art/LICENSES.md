# TankStorm — bundled asset licenses

Every bundled asset is **CC0 / public domain**. No attribution is legally
required; it is recorded here anyway so the provenance is never lost.

| File | Source | License |
|---|---|---|
| `detail-soil.jpg` | ambientCG — *Ground037* (converted to grayscale detail, 512px) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `detail-rock.jpg` | ambientCG — *Rock030* (converted to grayscale detail, 512px) | CC0 1.0 |
| `detail-grass.jpg` | ambientCG — *Grass001* (converted to grayscale detail, 512px) | CC0 1.0 |
| `explosion-atlas.webp` | OpenGameArt — *2D Explosion Animations (frame by frame)* (8×8 = 64 frames, resized to 1024²) | CC0 1.0 |
| `particle.webp` `smoke.webp` `spark.webp` `flash.webp` `ring.webp` `cloud.webp` `noise.jpg` | Generated procedurally for this project (`/tmp/tsassets/process.py` pipeline, numpy + Pillow) | CC0 1.0 |

The terrain photoscans are deliberately stored as **grayscale detail**, not
colour: the four battle themes (night / storm / lunar / inferno) supply colour
and the texture supplies only grain, so one texture set serves every theme.
