# Multi-resolution datasets

Gridlook can open a dataset that ships the same variables at several
resolutions and pick the resolution to render from the camera. Internally a
dataset is a list of _levels_; single-resolution datasets have exactly one and
behave as before.

## How levels are discovered

- **`multiscales` attribute.** When the root group (or the group a URL points
  at) carries a `multiscales` attribute, each entry it declares becomes one
  level, read from the named child group. Four layouts are understood:
  - OME-NGFF: `multiscales[0].datasets[].path` (0.4), or the same under
    `ome.multiscales` (0.5), listed finest first. A `scale` coordinate
    transformation together with `axes` that carry a length unit (`degree`,
    `metre`, `km`) gives the level's ground resolution.
  - [zarr-conventions `multiscales`](https://github.com/zarr-conventions/multiscales):
    `multiscales.layout[].asset`, taken in the order declared, which has to be
    finest first. The `transform.scale` of a layout entry is relative to
    another level, so the resolution comes from the level's grid (below). An
    asset that is an array and not a group is not a level.
  - GeoZarr: `multiscales[0].tile_matrix_limits` keyed by tile matrix (child
    group) id, or the `tileMatrices` of an inline `tile_matrix_set`. A tile
    matrix's `cellSize` is its resolution (degrees for a CRS84/EPSG:4326 set,
    the CRS unit, taken as metres, otherwise); with the `WebMercatorQuad` tile
    matrix set it follows from the zoom. Levels are sorted finest first.
  - zagg (`multiscales[0].spec` of `zagg-multiscales/1`): `base` is the
    finest level, followed by `datasets` as declared. A level's child group is
    named by its cell order, `cells[0]`; its `order` is the HEALPix node order
    the level was built at and is not a path. The cell order gives the
    resolution, the HEALPix cell size at `nside = 2^cellOrder`.
- **Grid metadata.** A level whose attributes do not state a resolution gets
  one from its grid where possible: the HEALPix `nside` (from the CRS
  variable's `healpix_nside`, the level group's DGGS `refinement_level`, or a
  `cell` dimension of length `12 nside²`) or the spacing of a one-dimensional
  `lon` coordinate on a regular grid. Every level also records how many cells it holds: the length of its spatial
  dimensions (`cell` for HEALPix, sparse or not; `lat · lon` or `y · x` on a
  regular grid).
- **JSON index.** An index file may list several `levels`, each with its own
  `datasources`, and may state `resolution` (metres per cell) and `cellCount`
  per level.

Levels without a resolution are still selectable by hand, but the camera
cannot choose between them. A group whose `multiscales` attribute yields fewer
than two usable levels is opened as a single-level dataset.

## How the level is picked

In every projection, also while the camera is moving, Gridlook measures the
ground distance one screen pixel covers at the point below the camera and
picks the level whose cells come nearest to **16 pixels** on screen (nearest
in log2 of the cell size). The active level is kept unless another level fits
better by more than **0.35 orders**, so panning along a boundary does not flip
back and forth. Where a projection stretches the map more one way than the
other, the coarser of the two directions counts, so cells are never smaller
than the target. A flat projection also stretches the map unevenly from place
to place, so away from the point below the camera the cells can be larger or
smaller on screen than the target.

A level switch keeps the view: the level on screen stays until the next one
has loaded and then replaces it in one frame. Triangular grids rebuild their
mesh first and are blank while the next level loads.

## Loading only what is in view

Regular lat/lon grids (one-dimensional `lat` and `lon` axes, not rotated or
projected) and nested HEALPix grids do not fetch a large level whole. A level
with more than **12 · 4^8 ≈ 786 000 cells** is loaded as the part the camera
sees plus a margin of half the view on every side:

- **Regular lat/lon:** an index window on both axes, requested as a slice.
  Zarr fetches only the chunks the slice touches. A window across the seam of
  a global longitude axis is fetched as two slices and stitched; around a
  pole the window takes every longitude and reads every n-th column.
- **HEALPix:** blocks of 4^6 cells, six orders above the level, which are
  contiguous in nested order and a square on their face. A dense level reads
  them by index. A level with a `cell` coordinate must store it in ascending
  nested order; the coordinate is then searched chunk by chunk and never read
  whole. Every chunk is checked as it is read, and a coordinate found out of
  order makes the level load whole.

The window is reloaded in place once the view leaves it; moving inside it
fetches nothing. While the camera keeps moving, a window that is already
loading is shown before the next one is requested. With a level picked by
hand that is too fine for the view, the window is cut down to the budget
around the point below the camera.

The coarsest level is the exception: it is always loaded whole. It is drawn
under a finer level wherever that level has no cells on screen (outside its
window, or outside the region it covers), and the colour range and histogram
are taken from it, so colours do not shift as the view moves or the level
changes. A pyramid whose levels do not state their resolution has no known
coarsest level, and loads every level whole.

A level that is loaded by view can be of any size, so automatic selection has
no cap for it. Streamlines and the volume layer read the whole level: while
either is on, the cap below applies and levels up to it are loaded whole.

HEALPix levels in ring order or with an unsorted `cell` coordinate, rotated
and projected regular grids, and the other grid types load every level whole.
Every timestep then fetches and decodes as many values as the level has
cells, so automatic selection never picks such a level with more than
**12 · 4^10 ≈ 12.6 million cells** (about 50 MB of Float32 per timestep); a
sparse regional level counts only the cells it stores. A level whose cell
count is unknown is counted as a square grid as wide and as tall as the
equator at its resolution, `(2πR / resolution)²`, which is never less than a
global grid of that resolution holds. Finer levels remain available through
the manual picker.

Choosing a level in the **Variable** card turns automatic selection off; the
"Pick the level from the zoom" checkbox turns it back on. The selected level
is not part of the shareable URL.

## Variables derived from t-digests

A zagg morton-hive store (`hive+https://…`) keeps, per cell, a t-digest of its
observations: a ragged array of `(mean, weight)` centroids such as
`h_tdigest_signal`. Gridlook lists two variables per digest, computed in the
browser from the centroids and not stored:

- `h_percentile_<stratum>`: the height at one percentile (default 50), set
  with the slider under the variable.
- `h_range_<stratum>`: the difference between two percentiles (default
  p98 − p2).

Heights are shown as stored, in metres above the WGS84 ellipsoid. Quantiles
follow zagg's `quantile_from_tdigest`, so a value is the one the Python reader
gives. The percentiles are part of the shareable URL (`percentile`,
`percentilelow`, `percentilehigh`).

Such a variable is loaded like any other, by level and by view, but a cell's
digest is a few kilobytes where a stored value is a few bytes: a view reads
tens of megabytes. Decoded digests are kept in memory (up to 256 MB, least
recently used first out), so moving a percentile slider recomputes the field
without reading anything.

Clicking a cell pins it in the **Height distribution** panel: the photons per
metre of height of the signal and, muted, of the noise, with the selected
percentiles marked. The pinned place is looked up again at every level that
comes on screen. With the Data Picker on and a derived variable displayed, the
panel follows the cursor from the digests already in memory; hovering never
reads the store, so over a stored variable such as `count` only a click opens
the panel.

## Levels derived from the leaves

A zagg store holds its leaves (cell order 19 in the stores so far) and then
levels from the leaf column down (order 13 and coarser). The orders in
between are not stored. Gridlook lists them as levels of their own, named
"order 15 (derived)", and computes them in the browser from the leaf chunks.
The two finest orders, 18 and 19, are no level: past derived order 17 the
viewer shows the points themselves (`POINT_TIER_ORDERS` in `hiveStore.ts`,
and "The point tier" below), so order 18 is not derived and the leaves,
`/19`, are not in the level list. They stay in the hierarchy as the source every derived level
and the distribution panel read from. The zoom therefore stops at order 17,
and a level index kept from a longer list falls back to the finest level.

- One chunk of a leaf array holds the 4096 leaf cells below one order-13
  cell, in nested order. Chunk `n` therefore is chunk `n` of every derived
  level: at order `k` it holds the cells `[n · 4^(k−13), (n + 1) · 4^(k−13))`,
  and leaf cell `j` of the chunk lies below derived cell `j >> 2 · (19 − k)`.
- `count` is the sum of the leaf counts. A height variable is computed from
  the pooled digest of the cell: the centroids of its leaf cells, sorted
  together, read with the same quantile law. Nothing is compressed, so where
  the leaves are lossless (one photon per centroid, all but about one cell in
  100 000) the pooled digest is the exact sample. Only the variable shown is
  read: `count` reads `count`, a signal height reads `h_tdigest_signal`.
- A derived level is always loaded by view, one leaf chunk per block, and at
  most 2048 chunks per window (a level picked by hand from far out is cut
  down around the point below the camera). It is never the backdrop, and
  with streamlines or a volume on it is left out of automatic selection.
- A leaf chunk is read once. Its decoded digests stay in memory, and so do
  the pooled ones (128 MB), so changing the percentile, or going from one
  derived order to another over the same ground, reads nothing.
- A chunk costs the same bytes whatever the order derived from it, so a
  derived level is picked at 32 pixels per cell for every variable, `count`
  included (a stored level keeps 16 for `count`).

The distribution panel shows the pooled digest of a derived cell: the
derived level names the leaf group it is computed from (`derived.dataset`),
and the digests are read there whether or not that group is a level.

## The point tier

Past derived order 17 the viewer shows the observations themselves: the
photons of the leaf chunks under the view, each drawn at its height. The
tier is a mode of the level selector, not a level: the picker shows
"points (signal)" while it is on, and the order-17 mesh is hidden, so the
cloud is drawn on black (the level is still read: a click pins its cells).
It exists on the globe only; a flat projection stops at the finest level.

- **Hand-off.** The tier comes on when a cell of the finest level would span
  **64 pixels** on screen (`POINT_TIER_PIXELS_PER_CELL`, twice the digest
  target), and stays on until the cells shrink by the usual 0.35 orders
  (about 50 px), so a view at the boundary does not flap. It needs a
  variable derived from a t-digest; under `count` the ladder ends at the
  finest level. A manual pick of a level turns it off, and "points" can be
  picked by hand too.
- **What is drawn.** For each leaf chunk under the view plus a half-view
  margin (the window a derived level reads, so a view that just left order
  17 reads nothing new), every centroid of the displayed digest
  (`h_tdigest_signal`) is one point: its height is the centroid's mean, its
  place the order-29 cell its located word names (`h_tdigest_signal_locations`,
  one word per centroid), decoded on the uint32 halves of the word. A lossy
  centroid (weight above 1, about one cell in 100 000) is one point at its
  mean, at the centre of its ancestor cell. Noise is not read.
- **Height.** A point sits at `r = 1 + (h − h_ref) · exaggeration / R` globe
  radii, with `R` the store's semi-major axis. The reference height `h_ref`
  is the lowest height drawn within the view's height of the pivot
  (`neighbourhoodRange` in `src/lib/points/pointRange.ts`), refreshed as
  chunks land: the datum floats on the view's lowest height, so the cloud
  always rises from the sphere at the pivot, over a 3 000 m plateau as
  over a beach, and a profile, whose window reaches the horizon, keeps it
  there. The exaggeration is the panel's slider (1 to 20, 1 by default):
  it stretches the heights above the datum, and the pivot's height and the
  gizmo's up bar stretch with them (both are shader uniforms). Positions are kept relative to each chunk's centre so that
  float32 resolves millimetres.
- **Colour.** The colour is the height on the current colormap, over the
  drawn points' own range: their 2nd to 98th percentile
  (`src/lib/points/pointRange.ts`), read from a uniform sample of at most
  65 536 of them and refreshed as chunks land or the decimation changes;
  the histogram in the appearance panel is the same sample's. A custom
  range still wins. Leaving the tier puts the level's range and histogram
  back (the shared range across levels, unless that is off). **Colour by
  time** (the panel's choice, offered when the digest declares a `times`
  sibling) colours each point by when it was observed instead: the
  sibling's toc words (zagg spec §8.3, one per centroid, read only then
  and cached with the chunk) decoded to days since 2018-01-01
  (`src/lib/points/pointTimes.ts`), with the same 2nd to 98th percentile
  range, labelled as UTC dates on the colour bar; a custom range is typed
  in those days.
- **Budget.** At most `OBSERVATION_POINT_BUDGET` (300 000) points are drawn:
  over it, every k-th centroid of every chunk is drawn, uniformly and
  deterministically, never by place. A window is priced before it is read
  at `OBSERVATION_CHUNK_BYTES` (74 KB) per chunk and cut down around the
  pivot to `OBSERVATION_FETCH_CAP` (24 MB). Decoded chunks are cached (64 MB)
  beside the digest chunks they came from. Everything is in
  `src/lib/points/pointBudget.ts`.
- **Camera.** On entering, the orbit's target moves from the globe's centre
  to the ground under the view centre and the camera's up to the local
  vertical. The controls, espg's ruling on gridlook#25, shown as a one-line
  legend under the level picker while the tier is on: **the left button
  (one finger, the arrow keys) pans** in the ground plane, the pivot
  sliding along the surface; **shift + left, the right button (two
  fingers) orbit** the pivot, tilting from nadir to 90° and turning about
  the vertical with the horizon kept up; **the middle button and the wheel
  (+/-) dolly toward the ground under the cursor**, which stays under the
  cursor. The globe keeps its own buttons (left drag rotates it). The
  camera comes no closer than 200 m to the pivot and stays at least 100 m
  above the surface, except tilted to the profile, where it is at ground
  level and the wheel stops 200 m short of the pivot instead. Leaving puts
  the camera back on the globe orbit above the pivot at its altitude.
- **Mode buttons.** **Pan** (the default) and **Orbit** under the legend
  set what a plain left drag (one finger) does; shift + left and the right
  button (two fingers) orbit whichever is on, and the arrow keys pan. The
  legend says which is on. The globe's buttons are untouched.
- **Pivot height.** The pivot is lifted off the sphere to the middle of
  the relief around it (the datum to the highest point within the view's
  height of it), so an orbit turns about the cloud and a profile centres
  it; the pivot stays on the sphere's vertical, so a nadir view does not
  notice. The lift follows the relief as chunks land.
- **Opacity.** The panel's slider (0.05 to 1, 1 by default) scales the
  points' alpha (`pointOpacity`, a uniform of the falloff fragment shader),
  so dense tracks show their depth; the splat's soft edge stays.
- **Axes.** A gizmo at the datum under the pivot: east, north and up bars
  ticked at half and full length in metres (km from 1 km), the up bar
  scaled like the points. The bars are the largest nice length (1, 2, 5 ×
  10^k m) within a quarter of the view's height at the pivot's depth, so
  they rescale with the zoom (`src/lib/points/pointAxes.ts`,
  `usePointAxes.ts`). The gizmo is drawn over the points and never answers
  a click. The distance scale at the bottom left measures under the cursor
  as everywhere else.
- **View buttons.** Under the legend, **Top** and **Profile** animate the
  tilt (0.6 s, eased) to nadir and to 90°, a side elevation of the cloud
  with the up axis in view, keeping the azimuth and the pivot; from nadir
  a profile backs away behind the bottom of the screen, so it looks the
  way the view faced, and backs off (never in) until the relief around
  the pivot spans 80 % of the view's height. Orbit drags work from either view. A
  profile sees to the horizon, so its window grows to the fetch cap.
- **Panel.** A click pins the order-17 cell's digest, as on level 17.

## Filling the gaps between tracks

At fine levels the cells with photons are ground tracks with blank cells in
between. **Smooth gaps**, under a height variable, fills the blank cells. It
is offered, and applied, on a derived level only: a stored level is drawn as
read, its controls are not shown there, and the setting waits for the next
derived level (it stays in the URL either way).

- What is smoothed is the field on screen, the height at the chosen
  percentile in each cell, not the digests. Averaging a percentile over
  neighbouring cells interpolates between their distributions and keeps the
  percentiles in order; merging their digests would give a mixture, whose
  median jumps from one track's to the other's. A percentile range is the
  difference of its two percentile fields, each filled on its own.
- The filter is a normalised convolution with a Gaussian kernel:
  `conv(value · mask) / conv(mask)`, where `mask` is 1 on a cell with data.
  A cell with data keeps its value. A blank cell takes the weighted mean of
  the data under the kernel, and stays blank when there is none.
- The kernel is 3, 5, 7, 9, 15 or 31 cells across and reaches three standard
  deviations either way: `size = 2 · ceil(3σ) + 1`, so `σ = (size − 1) / 6`
  cells (0.33 to 5).
- It runs on the (x, y) grid of each HEALPix face over the cells loaded. A
  cell is not filled from across a face boundary, nor from cells outside the
  loaded window.
- The colour range and the histogram stay those of the values observed. The
  hover readout marks a filled value as interpolated, and the distribution
  panel says so and shows the filled heights instead of a curve.
- `count` is never smoothed. The setting is part of the shareable URL
  (`smooth`, `smoothkernel`).
