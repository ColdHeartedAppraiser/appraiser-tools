// GA Appraisals — Zoning Lookup
// Uses confirmed ZIMAS ArcGIS REST services with correct coordinate system (WKID 2229)
// Jurisdiction: Layer 7 (Boundaries MapServer, WGS84) = City of LA
// Zone data: ZIMAS zoning/MapServer/1102 (State Plane 2229)

const GOOGLE_GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';

// City boundary — uses WGS84, confirmed working
const LA_CITY_BOUNDARY = 'https://maps.lacity.org/lahub/rest/services/Boundaries/MapServer/7/query';

// ZIMAS services — use State Plane 2229, need inSR=4326 + outSR conversion
// Confirmed from zimas.lacity.org/arcgis/rest/services/zma/
const ZIMAS = {
  zoning:     'https://zimas.lacity.org/arcgis/rest/services/zma/zoning/MapServer/1102/query',
  zoningNew:  'https://zimas.lacity.org/arcgis/rest/services/zma/zoning/MapServer/1101/query',
};

// LA County eGIS (unincorporated) — uses WGS84
const LA_COUNTY = {
  zoning:      'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/4/query',
  generalPlan: 'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/2/query',
  fireHazard:  'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/13/query',
};

// Query ArcGIS layer — inSR=4326 works for most LA City/County layers
async function queryLayer(url, lat, lng, outFields, inSR) {
  const sr = inSR || '4326';
  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: parseInt(sr) } }),
    geometryType: 'esriGeometryPoint',
    inSR: sr,
    spatialRel: 'esriSpatialRelIntersects',
    outFields: outFields || '*',
    returnGeometry: 'false',
    resultRecordCount: '1',
  });
  try {
    const resp = await fetch(url + '?' + params.toString(), { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.error) return null;
    return data.features && data.features.length > 0 ? data.features[0].attributes : null;
  } catch(e) {
    return null;
  }
}

async function detectJurisdiction(lat, lng) {
  // Layer 7 = confirmed City of LA boundary polygon, WGS84
  const result = await queryLayer(LA_CITY_BOUNDARY, lat, lng, 'OBJECTID');
  if (result) return 'city_la';

  // Check LA County eGIS for unincorporated
  const county = await queryLayer(LA_COUNTY.zoning, lat, lng, 'ZONE_CODE,ZONE_CLASS,ZONE');
  if (county && (county.ZONE_CODE || county.ZONE_CLASS || county.ZONE)) return 'uninc_la';

  return 'other';
}

async function queryZIMASZoning(lat, lng) {
  // ZIMAS uses State Plane 2229 but accepts inSR=4326 for input geometry
  const result = await queryLayer(ZIMAS.zoning, lat, lng, 'ZONE_CMPLT,ZONE_CLASS,HEIGHT_DIS,ZONE_SMRY', '4326');
  if (result && (result.ZONE_CMPLT || result.ZONE_CLASS)) return result;

  // Try Chapter 1A (newer Downtown zones)
  const result2 = await queryLayer(ZIMAS.zoningNew, lat, lng, 'ZONE_CMPLT,ZONE_CLASS,HEIGHT_DIS', '4326');
  if (result2 && (result2.ZONE_CMPLT || result2.ZONE_CLASS)) return result2;

  return null;
}

function parseZoning(zone) {
  if (!zone) return { base: null, heightDistrict: null, conditional: null, raw: null };
  const z = zone.toUpperCase().trim();
  const m = z.match(/^([QT]?)\(?([A-Z0-9][A-Z0-9.]*)-?(\d[A-Z0-9]*)?/);
  return {
    base: m ? m[2] : z,
    heightDistrict: m ? m[3] : null,
    conditional: m && m[1] ? m[1] : null,
    raw: zone
  };
}

function determineSB9(zone, isHPOZ, fireZone) {
  if (!zone) return 'unknown — insufficient zoning data';
  const z = zone.toUpperCase();
  const isSFR = z.startsWith('R1') || z.startsWith('RS') || z.startsWith('RE') || z === 'RA';
  if (!isSFR) return 'not applicable — not a single-family zone';
  if (isHPOZ) return 'likely ineligible — HPOZ requires additional review';
  if (fireZone && fireZone.toUpperCase().includes('HIGH')) return 'requires fire hardening review under SB9';
  return 'potentially eligible — single-family zone; confirm no specific plan exclusions';
}

function buildFeasible(zoneBase, isTOC, tocTier) {
  if (!zoneBase) return 'To be determined based on zoning analysis.';
  const z = zoneBase.toUpperCase();
  if (z.startsWith('R1') || z === 'RS' || z.startsWith('RE') || z === 'RA') {
    let t = 'Single-family residential use with ADU is financially feasible given current market conditions.';
    if (isTOC) t += ' TOC Tier ' + tocTier + ' density bonus available for qualified affordable projects.';
    return t;
  }
  if (z.startsWith('R2')) return 'Two-family residential use is financially feasible; single-family with ADU also viable.';
  if (z.startsWith('R3') || z.startsWith('RD')) return 'Multi-family residential development is financially feasible given zone allowances and market demand.';
  if (z.startsWith('C')) return 'Commercial or mixed-use development is financially feasible; verify per height district and specific plan.';
  return 'Financial feasibility to be determined based on zoning allowances, market demand, and development costs.';
}

function buildMaxProd(zoneBase, isHPOZ, isTOC) {
  if (!zoneBase) return 'To be determined.';
  const z = zoneBase.toUpperCase();
  if (z.startsWith('R1') || z === 'RS' || z.startsWith('RE') || z === 'RA') {
    if (isHPOZ) return 'Single-family residence with ADU — HPOZ constraints limit significant alterations.';
    return 'Single-family residence with ADU as secondary improvement to maximize land utility under current zoning.';
  }
  if (z.startsWith('R2')) return 'Duplex or single-family with detached ADU to maximize allowable residential density.';
  if (z.startsWith('R3') || z.startsWith('RD')) {
    if (isTOC) return 'Maximum allowable multi-family residential development utilizing TOC density bonus for highest land value.';
    return 'Maximum allowable multi-family residential development per zone and height district standards.';
  }
  if (z.startsWith('C')) return 'Commercial or mixed-use development at maximum allowable FAR per height district to maximize productivity.';
  return 'Use generating the highest value consistent with legal, physical, and financial constraints.';
}

function buildVacant(zoneBase, isTOC, isHillside) {
  if (!zoneBase) return 'To be determined based on zoning analysis.';
  const z = zoneBase.toUpperCase();
  if (z.startsWith('R1') || z === 'RS' || z.startsWith('RE') || z === 'RA') {
    if (isHillside) return 'Development of a single-family residence consistent with hillside grading ordinance requirements.';
    return 'Development of a single-family residence with optional ADU as permitted by right under state law.';
  }
  if (z.startsWith('R2')) return 'Development of a duplex or single-family residence with ADU to maximize allowable residential density.';
  if (z.startsWith('R3') || z.startsWith('RD')) {
    if (isTOC) return 'Development of a multi-family residential project utilizing TOC density bonus to maximize unit count and land value.';
    return 'Development of a multi-family residential project at maximum allowable density per zone standards.';
  }
  if (z.startsWith('C')) return 'Development of a commercial or mixed-use project at maximum allowable FAR consistent with height district and general plan.';
  return 'Development of the highest and best use consistent with zoning, physical characteristics, and market demand.';
}

function buildHBUData(jurisdiction, zoningAttrs, generalPlan, toc, hpoz, specificPlan, fireHazard, hillside, address) {
  const rawZone = zoningAttrs
    ? (zoningAttrs.ZONE_CMPLT || zoningAttrs.ZONE_CLASS || zoningAttrs.ZONE_CODE || zoningAttrs.ZONE || null)
    : null;
  const heightDistrict = zoningAttrs ? (zoningAttrs.HEIGHT_DIS || null) : null;

  const z = parseZoning(rawZone);
  const isHPOZ = !!(hpoz);
  const isTOC = !!(toc);
  const tocTier = toc ? (toc.TIER || toc.TOC_TIER || toc.Tier || '—') : null;
  const fireZone = fireHazard ? (fireHazard.HAZ_CLASS || fireHazard.ZONE || '') : null;
  const isHillside = !!(hillside);
  const gpLandUse = generalPlan ? (generalPlan.GPLU || generalPlan.LU || generalPlan.LAND_USE || '—') : '—';
  const spName = specificPlan ? (specificPlan.SP_NAME || specificPlan.NAME || null) : null;
  const zoneBase = z.base || '—';
  const displayZone = rawZone || '—';
  const hd = heightDistrict || z.heightDistrict;

  let permitted = 'Base zone: ' + displayZone;
  if (z.conditional) permitted += ' (' + (z.conditional === 'Q' ? 'Q-condition applies' : 'T-condition applies') + ')';
  if (hd) permitted += '; Height District ' + hd;
  if (gpLandUse && gpLandUse !== '—') permitted += '; General Plan: ' + gpLandUse;
  if (spName) permitted += '; within ' + spName + ' Specific Plan';
  if (isHPOZ) permitted += '; HPOZ — historic preservation overlay applies';
  if (isTOC && tocTier) permitted += '; TOC Tier ' + tocTier + ' — density bonus eligible';
  permitted += '; ADU and JADU permitted by right per state law';

  let physical = 'To be confirmed from inspection and physical observation.';
  if (isHillside) physical = 'Hillside area — grading ordinance applies; slope analysis required.';
  if (fireZone) physical += ' Fire Hazard Severity Zone: ' + fireZone + ' — fire hardening requirements apply.';

  const flags = [];
  if (isHPOZ) flags.push('HPOZ — exterior alterations require HPOZ board approval');
  if (spName) flags.push('Specific Plan (' + spName + ') — may impose additional standards');
  if (isTOC) flags.push('TOC Tier ' + tocTier + ' — density bonus available for affordable housing projects');
  if (isHillside) flags.push('Hillside Grading Ordinance applies');
  if (fireZone && fireZone !== '') flags.push('Fire Hazard Zone: ' + fireZone);

  const feasible = buildFeasible(zoneBase, isTOC, tocTier);

  return {
    jurisdiction: jurisdiction,
    address: address,
    rawZone: displayZone,
    zoneBase: zoneBase,
    heightDistrict: hd,
    generalPlan: gpLandUse,
    specificPlan: spName,
    isHPOZ: isHPOZ,
    isTOC: isTOC,
    tocTier: tocTier,
    fireZone: fireZone,
    isHillside: isHillside,
    sb9: determineSB9(displayZone, isHPOZ, fireZone),
    permitted: permitted,
    physical: physical,
    feasible: feasible,
    flags: flags,
    hbu: {
      zoning: displayZone + (hd ? '-' + hd : '') + (gpLandUse !== '—' ? ' — General Plan: ' + gpLandUse : ''),
      permitted: permitted,
      physical: physical + ' Confirm lot dimensions, utilities, topography.',
      feasible: feasible,
      maxprod: buildMaxProd(zoneBase, isHPOZ, isTOC),
      vacant: buildVacant(zoneBase, isTOC, isHillside),
      improved: 'Continued use as currently improved, subject to confirmation of condition, functional utility, and market support.',
    }
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const googleKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!googleKey) return { statusCode: 500, body: JSON.stringify({ error: 'Google Maps API key not configured' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { address } = body;
  if (!address) return { statusCode: 400, body: JSON.stringify({ error: 'Address is required' }) };

  // Geocode
  let lat, lng, formattedAddress;
  try {
    const geoResp = await fetch(GOOGLE_GEOCODE + '?address=' + encodeURIComponent(address) + '&key=' + googleKey);
    const geoData = await geoResp.json();
    if (!geoData.results || !geoData.results.length)
      return { statusCode: 404, body: JSON.stringify({ error: 'Address not found. Please verify and try again.' }) };
    lat = geoData.results[0].geometry.location.lat;
    lng = geoData.results[0].geometry.location.lng;
    formattedAddress = geoData.results[0].formatted_address;
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Geocoding failed: ' + e.message }) };
  }

  // Detect jurisdiction
  const jurisdiction = await detectJurisdiction(lat, lng);

  // Query data based on jurisdiction
  let zoningAttrs = null, generalPlan = null, toc = null, hpoz = null,
      specificPlan = null, fireHazard = null, hillside = null;

  if (jurisdiction === 'city_la') {
    // Run ZIMAS zoning query + overlay queries in parallel
    const [zResult] = await Promise.allSettled([queryZIMASZoning(lat, lng)]);
    if (zResult.status === 'fulfilled') zoningAttrs = zResult.value;

    // Overlay layers — NavigateLA MapServer (best effort, layer IDs may need calibration)
    await Promise.allSettled([
      queryLayer('https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/110/query', lat, lng, 'GPLU,LU,GP_LAND_USE').then(function(r) { generalPlan = r; }),
      queryLayer('https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/162/query', lat, lng, 'TIER,TOC_TIER,Tier').then(function(r) { toc = r; }),
      queryLayer('https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/54/query',  lat, lng, 'HPOZ_NAME,NAME').then(function(r) { hpoz = r; }),
      queryLayer('https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/53/query',  lat, lng, 'SP_NAME,NAME').then(function(r) { specificPlan = r; }),
      queryLayer('https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/85/query',  lat, lng, 'HAZ_CLASS,ZONE').then(function(r) { fireHazard = r; }),
      queryLayer('https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/34/query',  lat, lng, 'HILLSIDE,TYPE').then(function(r) { hillside = r; }),
    ]);
  } else if (jurisdiction === 'uninc_la') {
    await Promise.allSettled([
      queryLayer(LA_COUNTY.zoning,      lat, lng, 'ZONE_CODE,ZONE_CLASS,ZONE').then(function(r) { zoningAttrs = r; }),
      queryLayer(LA_COUNTY.generalPlan, lat, lng, 'GPLU,LU,LAND_USE').then(function(r) { generalPlan = r; }),
      queryLayer(LA_COUNTY.fireHazard,  lat, lng, 'HAZ_CLASS,ZONE').then(function(r) { fireHazard = r; }),
    ]);
  }

  const hbuData = buildHBUData(jurisdiction, zoningAttrs, generalPlan, toc, hpoz, specificPlan, fireHazard, hillside, formattedAddress);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, address: formattedAddress, lat: lat, lng: lng, jurisdiction: jurisdiction, ...hbuData })
  };
};
