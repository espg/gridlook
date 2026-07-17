#include "../../projection/glsl/projectionConstants.glsl"
#include "../../shaders/glsl/isNaN.glsl"
#include "../../shaders/glsl/colormapFunctions.glsl"

uniform vec3 fillColor;
uniform float fillOpacity;
uniform int projectionType;
uniform float azimuthalClipRadius;
// choropleth: house colormap selected by index, raw feature values
// normalized with the grid materials' addOffset/scaleFactor convention
uniform int useChoropleth;
uniform int colormap;
uniform float addOffset;
uniform float scaleFactor;

varying float vHidden;
varying vec2 vProjectedXY;
varying float vFeatureValue;

void main() {
  if (vHidden > 0.5) {
    discard;
  }

  if (
    (projectionType == PROJ_AZIMUTHAL_EQUIDISTANT || projectionType == PROJ_AZIMUTHAL_HYBRID) &&
    length(vProjectedXY) > azimuthalClipRadius
  ) {
    discard;
  }

  if (useChoropleth == 1 && !is_nan(vFeatureValue)) {
    float normalized_value = clamp(addOffset + scaleFactor * vFeatureValue, 0.0, 1.0);
    #include "../../shaders/glsl/applyColormap.glsl"
    gl_FragColor.a = fillOpacity;
  } else {
    // features without the colorBy property keep the constant fill color
    gl_FragColor = vec4(fillColor, fillOpacity);
  }
}
