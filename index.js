const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const emailService = require('./EmailService');

// WhatsApp lazy-loading (safe for Railway — requires Chrome)
let whatsappService = null;
if (process.env.ENABLE_WHATSAPP === 'true') {
  try {
    whatsappService = require('./WhatsAppService');
  } catch (e) {
    console.warn('WhatsApp service unavailable:', e.message);
  }
}

const app = express();
const PORT = process.env.PORT || 5000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))
      return callback(null, true);
    callback(new Error('CORS: origin ' + origin + ' not allowed'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '16kb' }));

// ─────────────────────────────────────────────────────────────────────────────
// DISCOVERY ENGINE
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_ANGLES = [
  { label: 'Senior professionals',     suffix: 'Focus on senior-level (Manager, Director, VP, Head of).' },
  { label: 'Mid-level professionals',  suffix: 'Focus on mid-level professionals (Specialist, Lead, Associate, Coordinator).' },
  { label: 'Startup/SME sector',       suffix: 'Focus on people working at startups or small-to-medium enterprises.' },
  { label: 'Enterprise sector',        suffix: 'Focus on people at large corporations, multinationals, or NGOs.' },
  { label: 'Recently active',          suffix: 'Focus on people who would likely be actively hiring, posting jobs, or growing their team.' },
];

async function generateLeadBatch(query, angle, apiKey, batchSize = 10) {
  const prompt = `You are a professional B2B lead generation engine.
The user is searching for: "${query}"
${angle.suffix}

Generate exactly ${batchSize} realistic professional contacts that match this search.
Each contact must be a plausible real person one would find on LinkedIn.

Return ONLY a valid JSON array. No markdown, no explanation, no extra text.
Each object must have these exact fields:
- name (full name)
- title (job title)
- company (company name)
- location (city, country)
- email (realistic work email based on name and company)
- phone (realistic phone number with country code)
- linkedinUrl (realistic LinkedIn URL slug)
- context (1 sentence about why they are relevant to the search — their current challenge or activity)

Example format:
[{"name":"Jane Doe","title":"HR Director","company":"Acme Corp","location":"Nairobi, Kenya","email":"jane.doe@acme.com","phone":"+254 712 345 678","linkedinUrl":"https://linkedin.com/in/jane-doe-hr","context":"Currently scaling the HR team and rolling out a new performance management system."}]`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 2048 } },
      { timeout: 20000 }
    );

    const raw = response.data.candidates[0].content.parts[0].text;
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in response');
    return JSON.parse(match[0]);
  } catch (err) {
    console.error(`[DISCOVERY] Batch "${angle.label}" failed:`, err.message);
    return [];
  }
}

function deduplicateLeads(leads) {
  const seen = new Set();
  return leads.filter(l => {
    const key = (l.name || '').toLowerCase().trim() + '|' + (l.company || '').toLowerCase().trim();
    if (!l.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

app.post('/api/discover', async (req, res) => {
  const { query, limit = 50 } = req.body;
  const googleApiKey = process.env.GOOGLE_API_KEY;

  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'Query is required' });
  if (query.length > 300) return res.status(400).json({ error: 'Query too long' });
  if (!googleApiKey) return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });

  const cap = Math.min(Number(limit) || 50, 100);
  const batchSize = 10;
  const anglesNeeded = Math.ceil(cap / batchSize);
  const angles = Array.from({ length: anglesNeeded }, (_, i) => SEARCH_ANGLES[i % SEARCH_ANGLES.length]);

  console.log(`[DISCOVERY] "${query}" — running ${angles.length} parallel batches`);

  const batches = await Promise.all(angles.map(angle => generateLeadBatch(query, angle, googleApiKey, batchSize)));
  const merged = batches.flat();
  const unique = deduplicateLeads(merged);
  const final = unique.slice(0, cap).map(l => ({
    ...l,
    status: 'Discovered',
    discoveredDate: new Date().toISOString(),
    source: 'Synreach AI Engine',
  }));

  // HUNTER.IO ENRICHMENT (Optional Pro Feature)
  const hunterApiKey = process.env.HUNTER_API_KEY;
  if (hunterApiKey && final.length > 0) {
    console.log(`[DISCOVERY] Enriching with Hunter.io...`);
    const toEnrich = final.slice(0, 5);
    await Promise.all(toEnrich.map(async (lead, idx) => {
        try {
            const names = lead.name.split(' ');
            const hRes = await axios.get('https://api.hunter.io/v2/email-finder', {
                params: {
                    company: lead.company,
                    first_name: names[0],
                    last_name: names.slice(1).join(' '),
                    api_key: hunterApiKey
                },
                timeout: 5000
            });
            if (hRes.data?.data?.email) final[idx].email = hRes.data.data.email;
        } catch (e) { /* ignore */ }
    }));
  }

  res.json({ success: true, query, count: final.length, contacts: final });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI GENERATE
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { lead, industry, context } = req.body;
  const googleKey = process.env.GOOGLE_API_KEY;

  if (!googleKey) return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });
  if (!lead) return res.status(400).json({ error: 'lead is required' });

  const system = 'You are a professional writing a 2-3 sentence personalized outreach icebreaker. Output ONLY the message body.';
  const prompt = `Write an icebreaker for ${lead.name} (${lead.title} at ${lead.company}). Context: ${context || lead.context}. Rules: 2-3 sentences, human tone.`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleKey}`,
      { contents: [{ parts: [{ text: system + '\n\n' + prompt }] }] }
    );
    const text = response.data.candidates[0].content.parts[0].text;
    return res.json({ draft: text.trim() });
  } catch (error) {
    console.error('[AI GENERATE] Critical Failure:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'AI Generation failed', 
      details: error.response?.data?.error?.message || error.message 
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEND
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  const { method, recipient, subject, content } = req.body;

  if (!method || !recipient) return res.status(400).json({ error: 'Required fields missing' });

  try {
    if (method === 'whatsapp') {
      if (!whatsappService || !whatsappService.isReady) return res.status(503).json({ error: 'WhatsApp unavailable' });
      await whatsappService.safeSend(recipient, content.replace(/<[^>]*>/g, ''));
      return res.json({ success: true, method: 'whatsapp', deliveredAt: new Date().toISOString() });
    }

    const result = await emailService.sendEmail(recipient, subject || 'Partnership', content);
    res.json({ success: true, method: 'email', deliveredAt: new Date().toISOString(), details: result.message });
  } catch (error) {
    res.status(500).json({ error: 'Outreach failed' });
  }
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  emailReady: !!process.env.RESEND_API_KEY,
  whatsappReady: whatsappService?.isReady || false,
  aiReady: !!process.env.GOOGLE_API_KEY,
}));

app.listen(PORT, () => {
    console.log(`Synreach Backend running on port ${PORT}`);
    console.log(`[DIAGNOSTICS] AI Key: ${process.env.GOOGLE_API_KEY ? 'EXISTS' : 'MISSING'}`);
    console.log(`[DIAGNOSTICS] WhatsApp Token: ${process.env.WHATSAPP_TOKEN ? 'EXISTS' : 'MISSING'}`);
    console.log(`[DIAGNOSTICS] Phone ID: ${process.env.WHATSAPP_PHONE_ID ? 'EXISTS' : 'MISSING'}`);
});
