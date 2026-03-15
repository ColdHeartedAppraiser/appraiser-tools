// GA Appraisals — Zoning Lookup Function
// Jurisdiction: Layer 7 (City Boundary) = City of LA. No result = outside city.
// Zoning data: NavigateLA MapServer for LA City, eGIS for LA County.

const GOOGLE_GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';

// LA City — Boundaries MapServer (confirmed public)
const LA_CITY_BOUNDARY = 'https://maps.lacity.org/lahub/rest/services/Boundaries/MapServer/7/query';

// LA City — NavigateLA MapServer overlay layers
// Layer IDs verified from service directory at maps.lacity.org/lahub/rest/services
const LA_CITY = {
  // Generalized Zoning (layer 109 in NavigateLA full service)
  zoning:       'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/109/query',
  generalPlan:  'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/110/query',
  toc:          'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/162/query',
  hpoz:         'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/54/query',
  specificPlan: 'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/53/query',
  fireHazard:   'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/85/query',
  hillside:     'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/34/query',
};

// LA County eGIS (unincorporated)
const LA_COUNTY = {
  zoning:      'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/4/query',
  generalPlan: 'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/2/query',
  fireHazard:  'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/13/query',
};

async function queryLayer(url, lat, lng, outFields) {
  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: outFields || '*',
    returnGeometry: 'false',
    resultRecordCount: '1',
  });
  const resp = await fetch(url + '?' + params.toString(), { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.error) return null;
  return data.features && data.features.length > 0 ? data.features[0].attributes : null;
}

async function detectJurisdiction(lat, lng) {
  // Layer 7 = single City of LA boundary polygon. If point intersects = City of LA.
  try {
    const result = await queryLayer(LA_CITY_BOUNDARY, lat, lng, 'OBJECTID');
    if (result) return 'city_la';
  } catch (e) {}

  // Not in city — check if unincorporated LA County via eGIS zoning layer
  try {
    const r = await queryLayer(LA_COUNTY.zoning, lat, lng, 'ZONE_CODE,ZONE_CLASS,ZONE');
    if (r && (r.ZONE_CODE || r.ZONE_CLASS || r.ZONE)) return 'uninc_la';
  } catch (e) {}

  // Final fallback: county boundary layer 15
  try {
    const r = await queryLayer(
      'https://maps.lacity.org/lahub/rest/services/Boundaries/MapServer/15/query',
      lat, lng, 'CITY_TYPE'
    );
    if (r && (r.CITY_TYPE || '').toUpperCase() === 'UNINCORPORATED') return 'uninc_la';
  } catch (e) {}

  return 'other';
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

function buildHBUData(jurisdiction, zoningCode, generalPlan, toc, hpoz, specificPlan, fireHazard, hillside, address) {
  const z = parseZoning(zoningCode);
  const isHPOZ = !!(hpoz);
  const isTOC = !!(toc);
  const tocTier = toc ? (toc.TIER || toc.TOC_TIER || toc.Tier || '—') : null;
  const fireZone = fireHazard ? (fireHazard.HAZ_CLASS || fireHazard.ZONE || fireHazard.FireHazardSeverityZone || '') : null;
  const isHillside = !!(hillside);
  const gpLandUse = generalPlan ? (generalPlan.GPLU || generalPlan.LU || generalPlan.GP_LAND_USE || generalPlan.LAND_USE || '—') : '—';
  const spName = specificPlan ? (specificPlan.SP_NAME || specificPlan.NAME || null) : null;
  const zoneBase = z.base || '—';
  const rawZone = z.raw || '—';

  let permitted = 'Base zone: ' + rawZone;
  if (z.conditional) permitted += ' (' + (z.conditional === 'Q' ? 'Q-condition applies' : 'T-condition applies') + ')';
  if (z.heightDistrict) permitted += '; Height District ' + z.heightDistrict;
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
    rawZone: rawZone,
    zoneBase: zoneBase,
    heightDistrict: z.heightDistrict,
    generalPlan: gpLandUse,
    specificPlan: spName,
    isHPOZ: isHPOZ,
    isTOC: isTOC,
    tocTier: tocTier,
    fireZone: fireZone,
    isHillside: isHillside,
    sb9: determineSB9(rawZone, isHPOZ, fireZone),
    permitted: permitted,
    physical: physical,
    feasible: feasible,
    flags: flags,
    hbu: {
      zoning: rawZone + (z.heightDistrict ? '-' + z.heightDistrict : '') + (gpLandUse !== '—' ? ' — General Plan: ' + gpLandUse : ''),
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

  // Query overlays
  let zoning = null, generalPlan = null, toc = null, hpoz = null,
      specificPlan = null, fireHazard = null, hillside = null;
  const queries = [];

  if (jurisdiction === 'city_la') {
    queries.push(
      queryLayer(LA_CITY.zoning,       lat, lng, 'ZONE_CLASS,ZONE_CMPLT,ZONE_SMRY,HEIGHT_DIS').then(function(r) { zoning = r; }),
      queryLayer(LA_CITY.generalPlan,  lat, lng, 'GPLU,LU,GP_LAND_USE').then(function(r) { generalPlan = r; }),
      queryLayer(LA_CITY.toc,          lat, lng, 'TIER,TOC_TIER,Tier').then(function(r) { toc = r; }),
      queryLayer(LA_CITY.hpoz,         lat, lng, 'HPOZ_NAME,NAME').then(function(r) { hpoz = r; }),
      queryLayer(LA_CITY.specificPlan, lat, lng, 'SP_NAME,NAME,SPECIFIC_PLAN').then(function(r) { specificPlan = r; }),
      queryLayer(LA_CITY.fireHazard,   lat, lng, 'HAZ_CLASS,ZONE,FireHazardSeverityZone').then(function(r) { fireHazard = r; }),
      queryLayer(LA_CITY.hillside,     lat, lng, 'HILLSIDE,TYPE').then(function(r) { hillside = r; })
    );
  } else if (jurisdiction === 'uninc_la') {
    queries.push(
      queryLayer(LA_COUNTY.zoning,      lat, lng, 'ZONE_CODE,ZONE_CLASS,ZONE').then(function(r) { zoning = r; }),
      queryLayer(LA_COUNTY.generalPlan, lat, lng, 'GPLU,LU,LAND_USE').then(function(r) { generalPlan = r; }),
      queryLayer(LA_COUNTY.fireHazard,  lat, lng, 'HAZ_CLASS,ZONE').then(function(r) { fireHazard = r; })
    );
  }

  await Promise.allSettled(queries);

  const zoningCode = zoning
    ? (zoning.ZONE_CLASS || zoning.ZONE_CMPLT || zoning.ZONE_SMRY || zoning.ZONE_CODE || zoning.ZONE || null)
    : null;

  const hbuData = buildHBUData(jurisdiction, zoningCode, generalPlan, toc, hpoz, specificPlan, fireHazard, hillside, formattedAddress);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, address: formattedAddress, lat: lat, lng: lng, jurisdiction: jurisdiction, ...hbuData })
  };
};
