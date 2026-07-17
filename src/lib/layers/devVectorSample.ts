// Dev-only sample FeatureCollection shaped like zagg `shard_outlines`
// output, for exercising the vector layer before an injection UI exists.
// Loaded lazily behind `import.meta.env.DEV` (see LayerPanel.vue).

import type { FeatureCollection } from "geojson";

export const DEV_VECTOR_SAMPLE_ID = "dev-vector-sample";

export const devVectorSampleCollection: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { shard: "4331422" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-105, 38],
            [-95, 38],
            [-95, 45],
            [-105, 45],
            [-105, 38],
          ],
        ],
      },
    },
    {
      type: "Feature",
      properties: { shard: "4331423" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [20, 0],
            [20, 15],
            [0, 15],
            [0, 0],
          ],
          [
            [8, 5],
            [8, 9],
            [12, 9],
            [12, 5],
            [8, 5],
          ],
        ],
      },
    },
    {
      type: "Feature",
      properties: { shard: "4331424" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-60, -75],
              [-30, -75],
              [-30, -65],
              [-60, -65],
              [-60, -75],
            ],
          ],
          [
            [
              [150, -75],
              [170, -75],
              [170, -68],
              [150, -68],
              [150, -75],
            ],
          ],
        ],
      },
    },
  ],
};
