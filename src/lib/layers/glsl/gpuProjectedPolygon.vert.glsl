#include "../../projection/glsl/projectionShaderFunctions.glsl"
#include "../../shaders/glsl/isNaN.glsl"

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
uniform float zOffset;

attribute vec2 latLon;
attribute vec2 triLatLonB;
attribute vec2 triLatLonC;

varying float vHidden;
varying vec2 vProjectedXY;

// Slack of the azimuthal span test, in radians of projected distance. Matches
// the constant cutoff the line builder applies to its <= 2 degree segments.
const float AZIMUTHAL_SPAN_SLACK = 1.0;

bool isInvalidProjection(vec3 projected) {
  return is_nan(projected.x) || is_nan(projected.y) || is_nan(projected.z);
}

// Great-circle separation of two lat/lon corners, in radians.
float angularSeparation(vec2 a, vec2 b) {
  float latA = a.x * DEG_TO_RAD;
  float latB = b.x * DEG_TO_RAD;
  float deltaLon = (a.y - b.y) * DEG_TO_RAD;
  float cosSeparation =
    sin(latA) * sin(latB) + cos(latA) * cos(latB) * cos(deltaLon);
  return acos(clamp(cosSeparation, -1.0, 1.0));
}

void main() {
  vec3 projected = projectLatLon(
    latLon.x,
    latLon.y,
    projectionType,
    centerLon,
    centerLat,
    projectionRadius
  );
  vec3 projectedB = projectLatLon(
    triLatLonB.x,
    triLatLonB.y,
    projectionType,
    centerLon,
    centerLat,
    projectionRadius
  );
  vec3 projectedC = projectLatLon(
    triLatLonC.x,
    triLatLonC.y,
    projectionType,
    centerLon,
    centerLat,
    projectionRadius
  );

  bool hideTriangle =
    isInvalidProjection(projected) ||
    isInvalidProjection(projectedB) ||
    isInvalidProjection(projectedC);

  // Hide triangles straddling the flat-projection seam. All three corners
  // are known at every vertex, so the decision is identical across the
  // triangle and discards cleanly (mirrors the line-segment hiding).
  if (!hideTriangle && projectionType != PROJ_GLOBE) {
    vec2 rotated = rotateCoords(latLon.x, latLon.y, centerLon, centerLat);
    vec2 rotatedB = rotateCoords(
      triLatLonB.x,
      triLatLonB.y,
      centerLon,
      centerLat
    );
    vec2 rotatedC = rotateCoords(
      triLatLonC.x,
      triLatLonC.y,
      centerLon,
      centerLat
    );
    float maxLonGap = max(
      abs(rotated.y - rotatedB.y),
      max(abs(rotated.y - rotatedC.y), abs(rotatedB.y - rotatedC.y))
    );
    hideTriangle = maxLonGap > 180.0;
  }

  // For azimuthal projections, also hide triangles whose projected corners are
  // much further apart than the corners themselves are on the sphere. Earcut
  // connects non-adjacent ring vertices, so unlike a line segment a triangle is
  // not bounded by the <= 2 degree densified edge length; scaling the cutoff by
  // the corners' great-circle separation keeps genuinely wide fills, while
  // wraparound near the antipode (nearby corners projecting to opposite rims)
  // still produces a span >> separation and discards.
  if (!hideTriangle && (projectionType == PROJ_AZIMUTHAL_EQUIDISTANT || projectionType == PROJ_AZIMUTHAL_HYBRID)) {
    float maxSpan = max(
      distance(projected.xy, projectedB.xy),
      max(
        distance(projected.xy, projectedC.xy),
        distance(projectedB.xy, projectedC.xy)
      )
    );
    float maxSeparation = max(
      angularSeparation(latLon, triLatLonB),
      max(
        angularSeparation(latLon, triLatLonC),
        angularSeparation(triLatLonB, triLatLonC)
      )
    );
    hideTriangle =
      maxSpan > (maxSeparation + AZIMUTHAL_SPAN_SLACK) * projectionRadius;
  }

  vHidden = hideTriangle ? 1.0 : 0.0;
  if (hideTriangle) {
    vProjectedXY = vec2(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vProjectedXY = projected.xy;
  projected.z += zOffset;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
}
