// Zoning lookup function
// Flow: geocode address → detect jurisdiction → query appropriate GIS layers → return structured zoning data

const GOOGLE_GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';

// LA City GeoHub ArcGIS REST endpoints (public, no auth required)
const LA_CITY = {
  // Base zoning polygons
  zoning: 'https://maps.lacity.org/lahub/rest/services/City_Planning_Department/MapServer/0/query',
  // General plan land use
  generalPlan: 'https://maps.lacity.org/lahub/rest/services/City_Planning_Department/MapServer/1/query',
  // Transit Oriented Communities (TOC) tiers
  toc: 'https://maps.lacity.org/lahub/rest/services/City_Planning_Department/MapServer/23/query',
  // Historic Preservation Overlay Zones
  hpoz: 'https://maps.lacity.org/lahub/rest/services/City_Planning_Department/MapServer/6/query',
  // Specific plans
  specificPlan: 'https://maps.lacity.org/lahub/rest/services/City_Planning_Department/MapServer/7/query',
  // Very High Fire Hazard Severity Zone
  fireHazard: 'https://maps.lacity.org/lahub/rest/services/City_Planning_Department/MapServer/21/query',
  // Hillside area
  hillside: 'https://maps.lacity.org/lahub/rest/services/City_Planning_Department/MapServer/10/query',
};

// LA County eGIS endpoints (unincorporated areas)
const LA_COUNTY = {
  zoning: 'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/4/query',
  generalPlan: 'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/2/query',
  fireHazard: 'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/13/query',
};

// Query a single ArcGIS layer by lat/lng point
async function queryLayer(url, lat, lng, outFields = '*') {
  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry: 'false',
    resultRecordCount: '1',
  });
  const resp = await fetch(`${url}?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.error) return null;
  return data.features && data.features.length > 0 ? data.features[0].attributes : null;
}

// Determine if point is within City of LA boundary
async function detectJurisdiction(lat, lng) {
  try {
    const cityBoundaryUrl = 'https://maps.lacity.org/lahub/rest/services/Boundaries/MapServer/12/query';
    const result = await queryLayer(cityBoundaryUrl, lat, lng, 'CITY_NAME');
    if (result && result.CITY_NAME && result.CITY_NAME.toLowerCase().includes('los angeles')) {
      return 'city_la';
    }
  } catch (e) { /* fall through */ }
  
  // Check if in any incorporated city vs unincorporated county
  try {
    const countyUrl = 'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/0/query';
    const result = await queryLayer(countyUrl, lat, lng, 'CITY_TYPE');
    if (result && result.CITY_TYPE === 'UNINCORPORATED') return 'uninc_la';
  } catch (e) { /* fall through */ }

  return 'other';
}

// Parse zoning code into components for HBU analysis
function parseZoning(zone) {
  if (!zone) return { base: null, tier: null, overlay: null };
  const z = zone.toUpperCase().trim();

  // City of LA zone format: e.g. R1-1, RD1.5-1, C2-1VL, Q(R3-1), T(R2-1)
  const overlayMatch = z.match(/^([QT]?)\(?([A-Z0-9][A-Z0-9.]*)-?(\d[A-Z0-9]*)?/);
  const base = overlayMatch ? overlayMatch[2] : z;
  const heightDistrict = overlayMatch ? overlayMatch[3] : null;
  const conditional = overlayMatch && overlayMatch[1] ? overlayMatch[1] : null;

  return { base, heightDistrict, conditional, raw: zone };
}

// Determine SB9 eligibility based on zone and overlays
function determineSB9(zone, isHPOZ, isTOC, fireZone) {
  if (!zone) return 'unknown — insufficient zoning data';
  const z = zone.toUpperCase();
  const isSFR = z.startsWith('R1') || z.startsWith('RS') || z.startsWith('RE') || z === 'RA';
  if (!isSFR) return 'not applicable — not a single-family zone';
  if (isHPOZ) return 'likely ineligible — HPOZ requires additional review';
  if (fireZone && fireZone.includes('HIGH')) return 'requires additional fire hardening review under SB9';
  return 'potentially eligible — single-family zone; confirm no specific plan exclusions';
}

// Build HBU test data from all layer results
function buildHBUData(jurisdiction, zoning, generalPlan, toc, hpoz, specificPlan, fireHazard, hillside, address) {
  const z = parseZoning(zoning);
  const isHPOZ = !!(hpoz);
  const isTOC = !!(toc);
  const tocTier = toc ? (toc.TIER || toc.TOC_TIER || toc.Tier || '—') : null;
  const fireZone = fireHazard ? (fireHazard.HAZ_CLASS || fireHazard.ZONE || fireHazard.FireHazardSeverityZone || '') : null;
  const isHillside = !!(hillside);
  const gpLandUse = generalPlan ? (generalPlan.GPLU || generalPlan.LU || generalPlan.GeneralPlanLandUse || generalPlan.LAND_USE || '—') : '—';
  const specificPlanName = specificPlan ? (specificPlan.SP_NAME || specificPlan.NAME || specificPlan.SpecificPlan || null) : null;

  const zoneBase = z.base || '—';
  const rawZone = z.raw || '—';

  // Build legally permissible text
  let permitted = `Base zone: ${rawZone}`;
  if (z.conditional) permitted += ` (${z.conditional === 'Q' ? 'Q-condition applies' : 'T-condition applies'})`;
  if (z.heightDistrict) permitted += `; Height District ${z.heightDistrict}`;
  if (gpLandUse && gpLandUse !== '—') permitted += `; General Plan: ${gpLandUse}`;
  if (specificPlanName) permitted += `; within ${specificPlanName} Specific Plan`;
  if (isHPOZ) permitted += '; HPOZ — historic preservation overlay applies';
  if (isTOC && tocTier) permitted += `; TOC Tier ${tocTier} — density bonus eligible`;
  permitted += '; ADU and JADU permitted by right per state law';

  // Build physically possible text
  let physical = 'To be confirmed from inspection and physical observation.';
  if (isHillside) physical = 'Hillside area — grading ordinance applies; slope analysis required; reduced development potential possible.';
  if (fireZone) physical += ` Fire Hazard Severity Zone: ${fireZone} — fire hardening requirements apply.`;

  // Determine feasible use
  let feasible = buildFeasibleText(zoneBase, isTOC, tocTier, jurisdiction);

  // SB9 analysis
  const sb9 = determineSB9(rawZone, isHPOZ, isTOC, fireZone);

  // Additional flags
  const flags = [];
  if (isHPOZ) flags.push('HPOZ — exterior alterations require HPOZ board approval');
  if (specificPlanName) flags.push(`Specific Plan (${specificPlanName}) — may impose additional use or development standards`);
  if (isTOC) flags.push(`TOC Tier ${tocTier} — density bonus available for affordable housing projects`);
  if (isHillside) flags.push('Hillside Grading Ordinance applies');
  if (fireZone && fireZone !== '') flags.push(`Fire Hazard Zone: ${fireZone}`);

  return {
    jurisdiction,
    address,
    rawZone,
    zoneBase,
    heightDistrict: z.heightDistrict,
    generalPlan: gpLandUse,
    specificPlan: specificPlanName,
    isHPOZ,
    isTOC,
    tocTier,
    fireZone,
    isHillside,
    sb9,
    permitted,
    physical,
    feasible,
    flags,
    // Pre-filled HBU test fields
    hbu: {
      zoning: rawZone + (z.heightDistrict ? `-${z.heightDistrict}` : '') + (gpLandUse !== '—' ? ` — General Plan: ${gpLandUse}` : ''),
      permitted,
      physical: physical + ' Confirm lot dimensions, utilities, topography.',
      feasible,
      maxprod: buildMaxProd(zoneBase, isHPOZ, isTOC),
      vacant: buildVacantConclusion(zoneBase, isTOC, isHillside, jurisdiction),
      improved: 'Continued use as currently improved, subject to confirmation of condition, functional utility, and market support.',
    }
  };
}

function buildFeasibleText(zoneBase, isTOC, tocTier, jurisdiction) {
  if (!zoneBase) return 'To be determined based on zoning analysis.';
  const z = zoneBase.toUpperCase();
  if (z.startsWith('R1') || z === 'RS' || z.startsWith('RE') || z === 'RA') {
    let t = 'Single-family residential use with ADU is financially feasible given current market conditions and demand for owner-occupied housing.';
    if (isTOC) t += ` TOC Tier ${tocTier} density bonus available for qualified affordable projects.`;
    return t;
  }
  if (z.startsWith('R2')) return 'Two-family residential use is financially feasible; single-family with ADU also viable. Market demand supports both configurations.';
  if (z.startsWith('R3') || z.startsWith('RD')) return 'Multi-family residential development is financially feasible given zone allowances and market demand for rental housing in the subject area.';
  if (z.startsWith('C1') || z.startsWith('C2') || z.startsWith('CR')) return 'Commercial retail/service uses are financially feasible; mixed-use residential over commercial may also be viable depending on specific plan and height district allowances.';
  if (z.startsWith('CM')) return 'Commercial manufacturing uses are financially feasible; consider compatibility with surrounding land uses.';
  if (z.startsWith('P')) return 'Parking use or associated commercial use is financially feasible per zone allowances.';
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

function buildVacantConclusion(zoneBase, isTOC, isHillside, jurisdiction) {
  if (!zoneBase) return 'To be determined based on zoning analysis.';
  const z = zoneBase.toUpperCase();
  if (z.startsWith('R1') || z === 'RS' || z.startsWith('RE') || z === 'RA') {
    if (isHillside) return 'Development of a single-family residence consistent with hillside grading ordinance requirements and zone standards.';
    return 'Development of a single-family residence with optional ADU as permitted by right under state law.';
  }
  if (z.startsWith('R2')) return 'Development of a duplex or single-family residence with ADU to maximize allowable residential density.';
  if (z.startsWith('R3') || z.startsWith('RD')) {
    if (isTOC) return `Development of a multi-family residential project utilizing TOC density bonus to maximize unit count and land value.`;
    return 'Development of a multi-family residential project at maximum allowable density per zone standards.';
  }
  if (z.startsWith('C')) return 'Development of a commercial or mixed-use project at maximum allowable FAR consistent with height district and general plan.';
  return 'Development of the highest and best use consistent with zoning, physical characteristics, and market demand.';
}

// Main handler
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const googleKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!googleKey) return { statusCode: 500, body: JSON.stringify({ error: 'Google Maps API key not configured' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { address } = body;
  if (!address) return { statusCode: 400, body: JSON.stringify({ error: 'Address is required' }) };

  // Step 1: Geocode address
  let lat, lng, formattedAddress;
  try {
    const geoResp = await fetch(`${GOOGLE_GEOCODE}?address=${encodeURIComponent(address)}&key=${googleKey}`);
    const geoData = await geoResp.json();
    if (!geoData.results || geoData.results.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Address not found. Please verify the address and try again.' }) };
    }
    const loc = geoData.results[0].geometry.location;
    lat = loc.lat;
    lng = loc.lng;
    formattedAddress = geoData.results[0].formatted_address;
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Geocoding failed: ' + e.message }) };
  }

  // Step 2: Detect jurisdiction
  const jurisdiction = await detectJurisdiction(lat, lng);

  // Step 3: Query appropriate layers in parallel
  let zoning = null, generalPlan = null, toc = null, hpoz = null,
      specificPlan = null, fireHazard = null, hillside = null;

  const queries = [];

  if (jurisdiction === 'city_la') {
    queries.push(
      queryLayer(LA_CITY.zoning, lat, lng, 'ZONE_CLASS,ZONE_SMRY,HEIGHT_DIS,ZONE_CMPLT').then(r => { zoning = r; }),
      queryLayer(LA_CITY.generalPlan, lat, lng, 'GPLU,LU').then(r => { generalPlan = r; }),
      queryLayer(LA_CITY.toc, lat, lng, 'TIER,TOC_TIER').then(r => { toc = r; }),
      queryLayer(LA_CITY.hpoz, lat, lng, 'HPOZ_NAME,NAME').then(r => { hpoz = r; }),
      queryLayer(LA_CITY.specificPlan, lat, lng, 'SP_NAME,NAME,SPECIFIC_PLAN').then(r => { specificPlan = r; }),
      queryLayer(LA_CITY.fireHazard, lat, lng, 'HAZ_CLASS,ZONE,FireHazardSeverityZone').then(r => { fireHazard = r; }),
      queryLayer(LA_CITY.hillside, lat, lng, 'HILLSIDE,TYPE').then(r => { hillside = r; }),
    );
  } else if (jurisdiction === 'uninc_la') {
    queries.push(
      queryLayer(LA_COUNTY.zoning, lat, lng, 'ZONE_CODE,ZONE_CLASS,ZONE').then(r => { zoning = r; }),
      queryLayer(LA_COUNTY.generalPlan, lat, lng, 'GPLU,LU,LAND_USE').then(r => { generalPlan = r; }),
      queryLayer(LA_COUNTY.fireHazard, lat, lng, 'HAZ_CLASS,ZONE').then(r => { fireHazard = r; }),
    );
  }

  try {
    await Promise.allSettled(queries);
  } catch(e) { /* individual query errors handled by allSettled */ }

  // Extract key fields robustly across possible field name variations
  const zoningCode = zoning
    ? (zoning.ZONE_CLASS || zoning.ZONE_SMRY || zoning.ZONE_CMPLT || zoning.ZONE_CODE || zoning.ZONE || null)
    : null;

  // Step 4: Build HBU data
  const hbuData = buildHBUData(
    jurisdiction, zoningCode, generalPlan, toc, hpoz,
    specificPlan, fireHazard, hillside, formattedAddress
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      address: formattedAddress,
      lat, lng,
      jurisdiction,
      ...hbuData,
    })
  };
};
