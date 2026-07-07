// Real (approximate) solar-position math. No external ephemeris library needed --
// accurate to within ~1 degree, which is plenty for a game's day/night line.
const DEG = Math.PI / 180;

/** Day of year (1-366) for a JS Date, in UTC. */
function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const diff = date.getTime() - start;
  return Math.floor(diff / 86400000) + 1;
}

/** Solar declination in degrees for a given date (Cooper's approximation). */
function solarDeclination(date) {
  const n = dayOfYear(date);
  return -23.44 * Math.cos(((360 / 365) * (n + 10)) * DEG);
}

/**
 * Subsolar point: the (lat, lon) on Earth directly under the sun right now.
 * Longitude derived from UTC time (ignoring the ~±16 min equation-of-time
 * wobble -- a deliberate simplification, noted in DESIGN.md).
 */
function subsolarPoint(date = new Date()) {
  const dec = solarDeclination(date);
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = 180 - utcHours * 15;
  lon = ((lon + 180) % 360 + 360) % 360 - 180; // wrap to [-180, 180)
  return { lat: dec, lon };
}

/**
 * Solar elevation angle (degrees) at a given lat/lon, given the current
 * subsolar point. Positive = daylight, negative = night, ~0 = terminator.
 */
function solarElevation(lat, lon, subsolar) {
  const latR = lat * DEG;
  const decR = subsolar.lat * DEG;
  let hourAngle = lon - subsolar.lon;
  hourAngle = ((hourAngle + 180) % 360 + 360) % 360 - 180;
  const haR = hourAngle * DEG;
  const sinElev =
    Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
  return Math.asin(Math.max(-1, Math.min(1, sinElev))) / DEG;
}

module.exports = { subsolarPoint, solarElevation, solarDeclination, dayOfYear };
