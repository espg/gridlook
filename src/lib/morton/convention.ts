/**
 * The latitude convention of published morton (zagg/mortie) stores.
 *
 * mortie hashes geodetic WGS84 latitudes through a geodetic->authalic
 * conversion before the spherical HEALPix mapping, and applies the inverse
 * series on egress (espg/mortie#186 made this the default; englacial/zagg#549
 * confirmed the published source-coop stores shipped under it). Rendering
 * morton cells therefore MUST use healpix-geo's ellipsoidal (authalic-WGS84)
 * mode; plain sphere mode mis-places boundaries by up to ~0.1283 deg
 * (~14.26 km) near 45 deg latitude.
 *
 * Hardcoded, not sniffed from store attrs: the stores do not carry mortie
 * spec section 5's `"latitude"` token yet (gap flagged on englacial/zagg#549),
 * so the pin is keyed to the store generation per the espg/gridlook#8 ruling
 * (2026-09-11), which supersedes that issue body's older plain-sphere note.
 */
export const MORTON_STORE_ELLIPSOID = {
  // eslint-disable-next-line camelcase
  semi_major_axis: 6378137,
  // eslint-disable-next-line camelcase
  inverse_flattening: 298.257223563,
} as const;
