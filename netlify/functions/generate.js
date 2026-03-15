exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { systemPrompt, userPrompt, pdfBase64 } = body;

  const content = [];
  if (pdfBase64) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } });
  }
  content.push({ type: 'text', text: userPrompt });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content }]
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return { statusCode: resp.status, body: JSON.stringify({ error: data.error?.message || 'API error' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: data.content[0].text.trim() })
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
