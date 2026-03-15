exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const googleKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!googleKey) return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body' }) }; }

  const { input } = body;
  if (!input) return { statusCode: 400, body: JSON.stringify({ error: 'Input required' }) };

  try {
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&components=country:us&location=34.0522,-118.2437&radius=80000&strictbounds=false&types=address&key=${googleKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ predictions: data.predictions || [] })
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
