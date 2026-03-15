// Zoning lookup function
// Flow: geocode address → detect jurisdiction → query appropriate GIS layers → return structured zoning data

const GOOGLE_GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';

// LA City GeoHub ArcGIS REST endpoints (public, no auth required)
// ZIMAS is City of LA's authoritative zoning system.
// If a point returns data from ZIMAS, it IS City of LA — no boundary query needed.
// ZIMAS ArcGIS server: zimas.lacity.org/arcgis/rest/services
// NavigateLA is the comprehensive public viewer — same underlying data, confirmed queryable.

const ZIMAS = {
  // Generalized Zoning layer — confirmed in ZIMAS viewer
  zoning:       'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/109/query',
  generalPlan:  'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/110/query',
  toc:          'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/162/query',
  hpoz:         'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/54/query',
  specificPlan: 'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/53/query',
  fireHazard:   'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/85/query',
  hillside:     'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/34/query',
};

const LA_COUNTY = {
  zoning:      'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/4/query',
  generalPlan: 'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/2/query',
  fireHazard:  'https://arcgis.gis.lacounty.gov/arcgis/rest/services/DRP/LUIMS/MapServer/13/query',
};

// Core ZIMAS zoning query — tries multiple known field names
// Returns zone string if found, null if not City of LA
async function queryZIMASZoning(lat, lng) {
  // Try the ZIMAS direct ArcGIS server first
  const zimasEndpoints = [
    'https://zimas.lacity.org/arcgis/rest/services/zma/grey/MapServer/0/query',
    'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/109/query',
    'https://maps.lacity.org/arcgis/rest/services/Mapping/NavigateLA/MapServer/12/query',
  ];
  for (const url of zimasEndpoints) {
    try {
      const result = await queryLayer(url, lat, lng, '*');
      if (result) {
        // Try every possible field name ZIMAS might use
        const zone = result.ZONE_CLASS || result.ZONE_CMPLT || result.ZONE_SMRY ||
                     result.ZONE || result.ZoneClass || result.GeneralizedZone ||
                     result.GENZONE || result.Zone || null;
        if (zone) return { zone, source: url, raw: result };
        // Even if no zone field matched, if we got a result it's City of LA
        return { zone: null, source: url, raw: result };
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

async function detectJurisdiction(lat, lng) {
  // ZIMAS = City of LA. If ZIMAS has a record, it's City of LA.
  const zimasResult = await queryZIMASZoning(lat, lng);
  if (zimasResult) return 'city_la';

  // Not in ZIMAS — check if unincorporated LA County
  try {
    const result = await queryLayer(LA_COUNTY.zoning, lat, lng, 'ZONE_CODE,ZONE_CLASS,ZONE');
    if (result && (result.ZONE_CODE || result.ZONE_CLASS || result.ZONE)) return 'uninc_la';
  } catch (e) {}

  // Final fallback: county boundary layer
  try {
    const result = await queryLayer(
      'https://maps.lacity.org/lahub/rest/services/Boundaries/MapServer/15/query',
      lat, lng, 'CITY_NAME,CITY_TYPE'
    );
    if (result) {
      const cityType = (result.CITY_TYPE || '').trim().toUpperCase();
      if (cityType === 'UNINCORPORATED') return 'uninc_la';
    }
  } catch (e) {}

  return 'other';
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
  // ZIMAS = City of LA. Query ZIMAS first — result means City of LA AND gives us zone data.
  const zimasHit = await queryZIMASZoning(lat, lng);
  const jurisdiction = zimasHit ? 'city_la' : await (async () => {
    try {
      const r = await queryLayer(LA_COUNTY.zoning, lat, lng, 'ZONE_CODE,ZONE_CLASS,ZONE');
      if (r && (r.ZONE_CODE || r.ZONE_CLASS || r.ZONE)) return 'uninc_la';
    } catch(e) {}
    try {
      const r = await queryLayer(
        'https://maps.lacity.org/lahub/rest/services/Boundaries/MapServer/15/query',
        lat, lng, 'CITY_TYPE'
      );
      if (r && (r.CITY_TYPE||'').toUpperCase() === 'UNINCORPORATED') return 'uninc_la';
    } catch(e) {}
    return 'other';
  })();

  let zoning = zimasHit ? zimasHit.raw : null;
  let generalPlan = null, toc = null, hpoz = null,
      specificPlan = null, fireHazard = null, hillside = null;
  const queries = [];

  if (jurisdiction === 'city_la') {
    // If ZIMAS didn't return zone field, try dedicated zoning query
    if (!zimasHit || !zimasHit.zone) {
      queries.push(queryLayer(ZIMAS.zoning, lat, lng, 'ZONE_CLASS,ZONE_CMPLT,ZONE_SMRY,HEIGHT_DIS').then(r => { if(r) zoning = r; }));
    }
    queries.push(
      queryLayer(ZIMAS.generalPlan,  lat, lng, 'GPLU,LU,GP_LAND_USE').then(r => { generalPlan = r; }),
      queryLayer(ZIMAS.toc,          lat, lng, 'TIER,TOC_TIER,Tier').then(r => { toc = r; }),
      queryLayer(ZIMAS.hpoz,         lat, lng, 'HPOZ_NAME,NAME').then(r => { hpoz = r; }),
      queryLayer(ZIMAS.specificPlan, lat, lng, 'SP_NAME,NAME,SPECIFIC_PLAN').then(r => { specificPlan = r; }),
      queryLayer(ZIMAS.fireHazard,   lat, lng, 'HAZ_CLASS,ZONE,FireHazardSeverityZone').then(r => { fireHazard = r; }),
      queryLayer(ZIMAS.hillside,     lat, lng, 'HILLSIDE,TYPE').then(r => { hillside = r; }),
    );
  } else if (jurisdiction === 'uninc_la') {
    queries.push(
      queryLayer(LA_COUNTY.zoning,      lat, lng, 'ZONE_CODE,ZONE_CLASS,ZONE').then(r => { zoning = r; }),
      queryLayer(LA_COUNTY.generalPlan, lat, lng, 'GPLU,LU,LAND_USE').then(r => { generalPlan = r; }),
      queryLayer(LA_COUNTY.fireHazard,  lat, lng, 'HAZ_CLASS,ZONE').then(r => { fireHazard = r; }),
    );
  }

  await Promise.allSettled(queries);

  const zoningCode = zoning
    ? (zoning.ZONE_CLASS || zoning.ZONE_CMPLT || zoning.ZONE_SMRY ||
       zoning.ZONE_CODE || zoning.ZONE || zoning.ZoneClass || null)
    : (zimasHit && zimasHit.zone) || null;

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
