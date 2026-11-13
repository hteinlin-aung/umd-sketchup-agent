# 2F Pool Area - a towel station (test brief 7: the first build on 2F)

Model: `dev/UMD_DEV_2F.skp` (the 2F dev copy with the building: floor, walls, columns; never the MASTER)
Floor: 2F finish floor, z = 5.479 m. Build on this level, not in the pool.
Room group: `NEW_2F_Pool_Area_FitOut_v02 (STILL water concept)`

Intent (Urban Mind Detox, 2F "Releasing", STILL water): after the water you need a dry, quiet place to leave a
robe and pick up a towel, away from the wet pool edge and off the walking line between the loungers and the pool.

## The space (measured on the model, 2026-11-14 - read this before planning)

The pool basin is on the EAST side of the room (x 60.87..64.38), 1.2 m deep below the floor. The poolside floor
is to the west. Along the west side and along the north wall stand 3D Warehouse spa loungers with side tables and
olive trees; they are past the first 40 items, so they are NOT in the room summary, but they are real. The only free
floor left is the north-west corner of the north strip, between the north wall and the first lounger of the north
row (that lounger starts at x 57.96). Both pieces below go in that corner, against `WALL_LimePlaster_North`.

## Changes for now

1. **Robe bench.** A light oak bench standing on the floor in the north-west corner: 0.1 m south of the
   `WALL_LimePlaster_North`, shifted 3.2 m west of its centre, 1.6 m long (east-west), 0.45 m deep (north-south),
   0.45 m high.

2. **Towel shelf.** A slim light oak shelf fixed to the north wall right above the bench: touching the
   `WALL_LimePlaster_North` (0 m south of it), shifted 3.2 m west of its centre, 1.6 m long (east-west),
   0.25 m deep (north-south), 0.04 m thick, its underside 1.5 m above the floor.

3. **Tags.** Put everything new on the tag `2F Pool - Furniture (AGENT)`.

4. **Materials.** Light oak = RGB 196, 164, 120. Use the material name `UMD Light Oak`.

5. **Check it.** Take a screenshot, then save a copy as `UMD_DEV_2F_pool_build.skp`.

## Later (do not try now)

- (later) A row of robe hooks on the wall between the bench and the shelf: needs a wall-mounted component.
- (later) A potted plant at the east end of the bench (placeComponent, and a component chosen from the catalog).
