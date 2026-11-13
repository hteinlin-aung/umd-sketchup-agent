# 1F Meditation + Breathing - the threshold (test brief 5: building in a new room)

Model: `dev/UMD_DEV_1F_meditation.skp` (never the MASTER)
Floor: 1F finish floor, z = 1.489 m. The room box goes up to about 5.08 m (about 3.6 m above the floor).
Room group: `1F MEDITATION + BREATHING ROOMS (T133) - finishes, ceilings, screens, lighting`

The room is long east-west. The `BREATHING ROOM` is the west end, the `MEDITATION ROOM` the east end,
and between them is a corridor about 9.7 m wide.

Intent (Urban Mind Detox): the corridor is the threshold. You slow down, sit, take your shoes off,
and only then step onto the tatami. Low light oak pieces against the room walls, the middle kept open.

Why this brief: everything built so far was in the reception. This tests the planner in a room it was
never tuned on, where the anchors are whole rooms, not objects.

## Check before running (Windows)

- Look at the first two pictures from run 20261113_114239 (`b4new_1.png`, `b4new_3.png`). If the door into
  the breathing room is in the middle of its east wall, or the door into the meditation room is in the
  middle of its west wall, change "centred on it" below to a shift of 3.0 m north before running.

## Changes for now

1. **Shoe-off bench.** A built-in light oak bench against the east wall of the `BREATHING ROOM`,
   touching it, centred on it: 3.0 m long (north-south), 0.45 m deep, 0.45 m high, standing on the floor.

2. **Shoe shelf.** A low light oak shelf against the west wall of the `MEDITATION ROOM`, touching it,
   centred on it: 2.4 m long (north-south), 0.35 m deep, 0.40 m high, standing on the floor.

3. **A plant by the bench.** Place a potted plant component 0.4 m east of the `BREATHING ROOM`,
   shifted 2.4 m north of its centre (just past the north end of the bench).

4. **Tags.** Put everything new on the tag `1F Meditation - Furniture (AGENT)`.

5. **Material.** Light oak = RGB 196, 164, 120, material name `UMD Light Oak`.

6. **Check it.** Take a screenshot, then save a copy as `UMD_DEV_1F_meditation_build.skp`.

## Later (do not try now)

- (later) A floor cushion (zafu) on the tatami in each room: needs "inside a room, against its wall",
  which the planner cannot say yet (it only places things beside or on top of an item).
