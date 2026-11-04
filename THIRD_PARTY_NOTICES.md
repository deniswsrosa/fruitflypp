# Third-party code, data, and assets

Dependencies and assets retain their original licenses.

- **Fly-Saber:** original trained rate network, compound-eye renderer, model
  checkpoint and matching graph from [jackie-0110/Fly-Saber](https://github.com/jackie-0110/Fly-Saber),
  commit `2bfb6aa`. Copyright 2026 John Courtney, MIT license.
  The license and source details are included in `vendor/fly-saber/`.
- **Three.js r169:** copyright 2010–2024 three.js authors, MIT license.
  Full license: `public/vendor/LICENSE.three.js`.
- **MaleCNS v1.0:** connectome annotations and anatomical graph, CC BY 4.0.
  Credits: FlyEM (HHMI Janelia), University of Cambridge, MRC LMB and Google
  Research. Source: https://male-cns.janelia.org/.
  Coordinates are normalized/oriented for display; some upstream positions are
  inherited or estimated. Graph indices are preserved in the neural model.
- **Drosophila — Adult Fruit Fly — CT Scan:** by
  [etainproject](https://sketchfab.com/etainproject),
  [original model](https://sketchfab.com/3d-models/drosophila-adult-fruit-fly-ct-scan-ad29b897bd2b4e27bb04ab9d31baa117),
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Modifications: upright orientation, decimation, mesh classification, vertex
  colors, translucent rendering and front-leg rigging.

References to the legacy Thingiverse mesh in scripts/development notes concern
an older pipeline; that original STL is not included in this repository.
