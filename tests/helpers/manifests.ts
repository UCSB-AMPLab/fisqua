/**
 * Sample IIIF v3 manifest fixture matching Zasqua's structure.
 * 3 canvases, Spanish labels, homepage with reference code.
 */
export const sampleManifestUrl =
  "https://iiif.zasqua.org/co-ahr-gob-caj259-car005/manifest.json";

export const sampleManifest = {
  "@context": "http://iiif.io/api/presentation/3/context.json",
  id: sampleManifestUrl,
  type: "Manifest",
  label: {
    es: ["Carpeta 005, Caja 259"],
  },
  homepage: [
    {
      id: "https://zasqua.org/co-ahr-gob-caj259-car005/",
      type: "Text",
      label: { es: ["Carpeta 005, Caja 259"] },
      format: "text/html",
    },
  ],
  behavior: ["paged"],
  items: [
    {
      id: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p1`,
      type: "Canvas",
      label: { none: ["1"] },
      width: 3000,
      height: 4000,
      items: [
        {
          id: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p1/1`,
          type: "AnnotationPage",
          items: [
            {
              id: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p1/1/1`,
              type: "Annotation",
              motivation: "painting",
              body: {
                id: "https://iiif.zasqua.org/tiles/co-ahr-gob-caj259-car005/page-001/full/max/0/default.jpg",
                type: "Image",
                format: "image/jpeg",
                width: 3000,
                height: 4000,
                service: [
                  {
                    id: "https://iiif.zasqua.org/tiles/co-ahr-gob-caj259-car005/page-001",
                    type: "ImageService3",
                    profile: "level1",
                  },
                ],
              },
              target: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p1`,
            },
          ],
        },
      ],
    },
    {
      id: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p2`,
      type: "Canvas",
      label: { none: ["2"] },
      width: 3000,
      height: 3900,
      items: [
        {
          id: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p2/1`,
          type: "AnnotationPage",
          items: [
            {
              id: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p2/1/1`,
              type: "Annotation",
              motivation: "painting",
              body: {
                id: "https://iiif.zasqua.org/tiles/co-ahr-gob-caj259-car005/page-002/full/max/0/default.jpg",
                type: "Image",
                format: "image/jpeg",
                width: 3000,
                height: 3900,
                service: [
                  {
                    id: "https://iiif.zasqua.org/tiles/co-ahr-gob-caj259-car005/page-002",
                    type: "ImageService3",
                    profile: "level1",
                  },
                ],
              },
              target: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p2`,
            },
          ],
        },
      ],
    },
    {
      id: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p3`,
      type: "Canvas",
      label: { none: ["3"] },
      width: 2900,
      height: 4100,
      items: [
        {
          id: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p3/1`,
          type: "AnnotationPage",
          items: [
            {
              id: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p3/1/1`,
              type: "Annotation",
              motivation: "painting",
              body: {
                id: "https://iiif.zasqua.org/tiles/co-ahr-gob-caj259-car005/page-003/full/max/0/default.jpg",
                type: "Image",
                format: "image/jpeg",
                width: 2900,
                height: 4100,
                service: [
                  {
                    id: "https://iiif.zasqua.org/tiles/co-ahr-gob-caj259-car005/page-003",
                    type: "ImageService3",
                    profile: "level1",
                  },
                ],
              },
              target: `${sampleManifestUrl.replace("/manifest.json", "")}/canvas/p3`,
            },
          ],
        },
      ],
    },
  ],
};
