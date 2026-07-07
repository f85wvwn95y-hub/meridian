// One-time build step: converts world-atlas TopoJSON land data into a flat
// array of [lon, lat] rings we can ship to the browser and draw on canvas
// with a plain equirectangular projection (no d3 dependency needed client-side).
const fs = require("fs");
const path = require("path");
const topojson = require("topojson-client");
const topo = require("world-atlas/land-110m.json");

const geo = topojson.feature(topo, topo.objects.land);

const rings = [];
for (const feature of geo.features) {
  const geom = feature.geometry;
  if (!geom) continue;
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      // simplify: keep every 2nd point to cut payload size, round to 2 decimals
      const simplified = ring
        .filter((_, i) => i % 2 === 0)
        .map(([lon, lat]) => [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100]);
      if (simplified.length > 2) rings.push(simplified);
    }
  }
}

const outPath = path.join(__dirname, "..", "public", "land.json");
fs.writeFileSync(outPath, JSON.stringify(rings));
console.log(`Wrote ${rings.length} land rings to ${outPath}`);
