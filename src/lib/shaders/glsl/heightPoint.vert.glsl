// A point of the observation tier, on the globe only: `position` is its
// place on the unit sphere relative to the object's origin (the chunk's
// centre, carried by modelMatrix), `height` its height and `data_value`
// what it is coloured by (the height, or its time). The point is lifted
// along the local vertical by its height above the reference,
// exaggerated: r = 1 + (h - h_ref) * exaggeration / R.

uniform float heightReference;
uniform float heightExaggeration;
uniform float earthRadius;
uniform float basePointSize;
uniform float minPointSize;
uniform float maxPointSize;

attribute float height;
attribute float data_value;

varying float v_value;

void main() {
  v_value = data_value;
  vec3 vertical = normalize((modelMatrix * vec4(position, 1.0)).xyz);
  float lift = (height - heightReference) * heightExaggeration / earthRadius;
  vec4 mvPosition = modelViewMatrix * vec4(position + vertical * lift, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // screen pixels at the pivot's depth, larger nearer, clamped
  float depth = max(-mvPosition.z, 1e-9);
  gl_PointSize = clamp(basePointSize / depth, minPointSize, maxPointSize);
}
