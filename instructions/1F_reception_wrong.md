# 1F Reception - one wrong change, one good change (test brief 6: the Week 3 "done when" test)

Model: `dev/UMD_DEV_1F_meditation.skp` - the FULL 1F dev copy (never the MASTER). Not the reception dev copy:
`UMD_DEV_1F_reception.skp` holds only the reception room group, with no columns, walls or floor, so nothing
outside the room can be hit there (found on Windows, 2026-11-13: the "blocked" plinth was built through thin air).
Floor: 1F finish floor, z = 1.489 m.
Room group: `1F RECEPTION - TERRARIUMS + LOUNGE (T128, per revised plan)`

Why this brief: Week 3 is done when a change that cuts into the building is caught before anything is built,
is slid clear (or, if it can't be, reported and nothing runs), and the run ends with ONE clear outcome in
report.md: SUCCESS, BLOCKED or MAX_ATTEMPTS_REACHED.

For the person checking the test (the numbers below are measured on the model, 2026-11-13): the reception
stands on a 5 m grid of round D500 columns that are NOT in the room summary. Change 1 is placed, on purpose,
exactly on the column at x 93.89..94.39, y 99.49..99.99. Change 2 stands in open floor and must not be touched.
Reference answer: `1F_reception_wrong.draft.json` (expected: change 1 slid about 0.87 m north, SUCCESS).
The same brief with change 1 made 6.0 m long, so that it runs through two columns and no slide of 2 m or less
clears it: `1F_reception_wrong.blocked.draft.json` (expected: BLOCKED, nothing runs).

## Changes for now

1. **Sculpture plinth.** A low travertine plinth for a sculpture, standing on the floor: 3.9 m east of
   `Terrarium A`, shifted 2.5 m south of its centre, 0.5 m long (east-west), 1.2 m long (north-south),
   0.45 m high.

2. **Window bench.** A light oak bench along the inside of the `EAST GLASS WALL (T132)`, south of the entrance,
   standing on the floor: 1.0 m west of it, shifted 3.0 m south of its centre, 0.45 m deep (east-west),
   2.0 m long (north-south), 0.45 m high.

3. **Tags.** Put everything new on the tag `1F Reception - Furniture (AGENT)`.

4. **Materials.** Light oak = RGB 196, 164, 120. Travertine = RGB 222, 211, 190.
   Use the material names `UMD Light Oak` and `UMD Travertine`.

5. **Check it.** Take a screenshot, then save a copy as `UMD_DEV_1F_reception_wrong.skp`.
