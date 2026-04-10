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
// Strategy: run N parallel Gemini requests, each targeting a different
// sub-angle of the query (seniority, company size, sub-sector), then
// deduplicate and return the merged list.
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
}

function deduplicateLeads(leads) {
  const seen = new Set();
  return leads.filter(l => {
    const key = `${l.name?.toLowerCase().trim()}|${l.company?.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

app.post('/api/discover', async (req, res) => {
  const { query, limit = 50 } = req.body;
  const googleApiKey = process.env.GOOGLE_API_KEY;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query is required' });
  }
  if (query.length > 300) {
    return res.status(400).json({ error: 'Query too long (max 300 characters)' });
  }
  if (!googleApiKey) {
    return res.status(500).json({ error: 'GOOGLE_API_KEY not configured on server' });
  }

  const cap = Math.min(Number(limit) || 50, 1000);
  const batchSize = 10;
  const anglesNeeded = Math.ceil(cap / batchSize);
  // Cycle through angles if we need more batches than angles
  const angles = Array.from({ length: anglesNeeded }, (_, i) => SEARCH_ANGLES[i % SEARCH_ANGLES.length]);

  console.log(`[DISCOVERY] "${query}" — running ${angles.length} parallel batches (target: ${cap} leads)`);

  const batchPromises = angles.map(angle =>
    generateLeadBatch(query, angle, googleApiKey, batchSize)
      .catch(err => {
        console.warn(`[DISCOVERY] Batch "${angle.label}" failed:`, err.message);
        return []; // failed batch returns empty, others continue
      })
  );

  const batches = await Promise.all(batchPromises);
  const merged = batches.flat();
  const unique = deduplicateLeads(merged);
  const final = unique.slice(0, cap).map(l => ({
    ...l,
    status: 'Discovered',
    discoveredDate: new Date().toISOString(),
    source: 'Synreach AI Engine',
  }));

  console.log(`[DISCOVERY] Returning ${final.length} unique leads`);
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

  const system = `You are a thoughtful professional writing a 2-3 sentence personalized outreach icebreaker.
Focus on ${industry || 'general business'} context. No greetings, no sign-offs, no quotes. Output ONLY the message body.`;

  const prompt = `Write a personalized icebreaker for ${lead.name} (${lead.title || 'Professional'} at ${lead.company || 'their company'}).
Context: ${context || lead.context || 'their professional background'}.
Rules: exactly 2-3 sentences, human tone, never start with "I", end with a soft conversation opener.`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleKey}`,
      { contents: [{ parts: [{ text: `${system}\n\n${prompt}` }] }],
        generationConfig: { temperature: 0.85, maxOutputTokens: 220 } },
      { timeout: 15000 }
    );
    const text = response.data.candidates[0].content.parts[0].text;
    return res.json({ draft: text.trim() });
  } catch (error) {
    console.error('AI Generation Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to generate icebreaker' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEND
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  const { method, recipient, subject, content } = req.body;

  if (!method || !recipient) {
    return res.status(400).json({ error: 'method and recipient are required' });
  }

  try {
    if (method === 'whatsapp') {
      if (!whatsappService || !whatsappService.isReady) {
        return res.status(503).json({ error: 'WhatsApp not available on this server' });
      }
      const plain = content.replace(/<[^>]*>/g, '');
      await whatsappService.safeSend(recipient, plain);
      return res.json({ success: true, method: 'whatsapp', deliveredAt: new Date().toISOString() });
    }

    const result = await emailService.sendEmail(recipient, subject || 'Partnership Proposal', content);
    res.json({ success: true, method: 'email', deliveredAt: new Date().toISOString(), details: result.message });
  } catch (error) {
    console.error('Send error:', error.message);
    res.status(500).json({ error: 'Outreach failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  emailReady: !!process.env.RESEND_API_KEY,
  whatsappReady: whatsappService?.isReady || false,
  aiReady: !!process.env.GOOGLE_API_KEY,
}));

app.listen(PORT, () => console.log(`Synreach Backend running on port ${PORT}`));
