# Multi-resolution datasets

Gridlook can open a dataset that ships the same variables at several
resolutions and pick the resolution to render from the camera. Internally a
dataset is a list of _levels_; single-resolution datasets have exactly one and
behave as before.

## How levels are discovered

- **`multiscales` attribute.** When the root group (or the group a URL points
  at) carries a `multiscales` attribute, each entry it declares becomes one
  level, read from the named child group. Two layouts are understood:
  - OME-NGFF: `multiscales[0].datasets[].path`, listed finest first. A `scale`
    coordinate transformation together with `axes` that carry a length unit
    (`degree`, `metre`, `km`) gives the level's ground resolution.
  - GeoZarr: `multiscales[0].tile_matrix_limits` keyed by tile matrix (child
    group) id, sorted so the highest zoom comes first. With the
    `WebMercatorQuad` tile matrix set the resolution follows from the zoom.
- **Grid metadata.** A level whose attributes do not state a resolution gets
  one from its grid where possible: the HEALPix `nside` (from the CRS
  variable's `healpix_nside`, or a `cell` dimension of length `12 nside²`) or
  the spacing of a one-dimensional `lon` coordinate on a regular grid. This
  also records how many cells the level holds.
- **JSON index.** An index file may list several `levels`, each with its own
  `datasources`, and may state `resolution` (metres per cell) and `cellCount`
  per level.

Levels without a resolution are still selectable by hand, but the camera
cannot choose between them. A group whose `multiscales` attribute yields fewer
than two usable levels is opened as a single-level dataset.

## How the level is picked

On the globe, once the camera comes to rest, Gridlook computes the ground
distance one screen pixel covers at the point below the camera and picks the
level whose cells come nearest to **2 pixels** on screen (nearest in log2 of
the cell size). The active level is kept unless another level fits better by
more than **0.35 orders**, so panning along a boundary does not flip back and
forth. Flat projections have no camera height and keep the loaded level.

The renderers allocate whole-grid textures: the HEALPix path holds
`12 · 4^order` values per level regardless of how sparse the data is (order 10
is about 50 MB; order 12 about 800 MB, which stalls the tab), and a regular
grid's `nlat · nlon` texture is the same bound. Automatic selection therefore
never picks a level above **12 · 4^10 ≈ 12.6 million cells**; finer levels
remain available through the manual picker.

Choosing a level in the **Variable** card turns automatic selection off; the
"Pick the level from the zoom" checkbox turns it back on. The selected level
is not part of the shareable URL.
