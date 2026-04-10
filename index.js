const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const emailService = require('./EmailService');

// WhatsApp requires Chrome/Puppeteer — only load locally, not on cloud servers
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

// Supabase Init
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000').split(',');

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, same-origin server calls)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '16kb' }));

// Mock database/storage for discovered contacts
let discoveredContacts = [];

app.post('/api/discover', async (req, res) => {
  const { query } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query is required' });
  }
  if (query.length > 300) {
    return res.status(400).json({ error: 'Query too long (max 300 characters)' });
  }

  console.log(`Discovering contacts for: ${query}`);

  try {
    // 1. Integration with SerpApi (Using Google Search to find LinkedIn profiles)
    // Query format: "HR Managers in Lusaka" site:linkedin.com/in/
    
      const serpApiKey = process.env.SERP_API_KEY;
      const googleApiKey = process.env.GOOGLE_API_KEY;
      const googleCx = process.env.GOOGLE_CX; // Optional: Custom Search Engine ID
      let leads = [];

      if (serpApiKey) {
        const response = await axios.get('https://serpapi.com/search', {
          params: {
            q: `${query} site:linkedin.com/in/`,
            api_key: serpApiKey,
            engine: 'google'
          }
        });
        
        const organicResults = response.data.organic_results || [];
        leads = organicResults.map(result => ({
          name: result.title.split(' - ')[0] || 'Unknown Name',
          title: result.snippet ? result.snippet.split('...')[0] : 'Professional',
          linkedinUrl: result.link,
          source: 'SerpApi'
        }));
      } else if (googleApiKey) {
        console.log('Using Google Custom Search API...');
        // Fallback to Google Custom Search if API key is provided
        // Note: For production, user should provide a CX ID in .env
        const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
          params: {
            q: `${query} site:linkedin.com/in/`,
            key: googleApiKey,
            cx: googleCx || '42533b3b4f69e46a7' // Default or placeholder CX
          }
        });

        const items = response.data.items || [];
        leads = items.map(item => ({
          name: item.title.split(' - ')[0] || 'Unknown Name',
          title: item.snippet ? item.snippet.split('...')[0] : 'Professional',
          linkedinUrl: item.link,
          source: 'Google Search'
        }));
      }

      // ── AI Filtering ──────────────────────────────────────────────────────
      // Perform a sanity check on results if we have an AI key
      if (leads.length > 0 && googleApiKey) {
        console.log(`AI is filtering ${leads.length} candidates...`);
        try {
          const filterPrompt = `You are a lead qualification assistant. 
Review this list of potential leads found for the query: "${query}".
Output a JSON array of indices (0-indexed) for ONLY the leads that are genuinely relevant to the query.
Examine their titles and snippets. If it looks like a generic profile or irrelevant, exclude it.

Leads:
${leads.map((l, i) => `${i}: ${l.name} - ${l.title}`).join('\n')}

Output format: [0, 2, 5]`;

          const aiResponse = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleApiKey}`, {
            contents: [{ parts: [{ text: filterPrompt }] }]
          });
          
          const rawOutput = aiResponse.data.candidates[0].content.parts[0].text;
          const validIndices = JSON.parse(rawOutput.match(/\[.*\]/)[0]);
          leads = leads.filter((_, i) => validIndices.includes(i));
          console.log(`AI Qualifed ${leads.length} relevant leads.`);
        } catch (err) {
          console.error('AI Filtering failed, returning raw results:', err.message);
        }
      }

      // 2. Mockup Enrichment Logic (to be replaced by Apollo/Hunter API)
    const enrichedLeads = leads.map(lead => ({
      ...lead,
      email: `${lead.name.toLowerCase().replace(' ', '.')}@${lead.title.split(' - ').slice(-1)[0].toLowerCase().trim().replace(' ', '')}.com`,
      phone: `+260 ${Math.floor(Math.random() * 900) + 100} ${Math.floor(Math.random() * 900) + 100} ${Math.floor(Math.random() * 90) + 10}`,
      status: 'Discovered',
      discoveredDate: new Date().toISOString()
    }));

    // Simulate "Mining" progress for the frontend
    // In a real app, this might be handled via WebSockets or polling
    // For this task, we return the results, but the UI will simulate the progress bar

    res.json({
      success: true,
      query,
      count: enrichedLeads.length,
      contacts: enrichedLeads
    });

  } catch (error) {
    console.error('Discovery error:', error.message);
    res.status(500).json({ error: 'Failed to discover contacts' });
  }
});

app.post('/api/generate', async (req, res) => {
  const { lead, industry, context } = req.body;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const googleKey = process.env.GOOGLE_API_KEY;

  if (!googleKey && !anthropicKey) {
    return res.status(500).json({ error: 'AI services not configured on server' });
  }

  const system = `You are a thoughtful professional writing a 2-3 sentence personalized icebreaker. 
Focus on ${industry || 'general business'} context. No greetings, no sign-offs.`;
  
  const prompt = `Write a personalized icebreaker for ${lead.name} (${lead.title} at ${lead.company}). 
Context: ${context || lead.context}. Rules: 2-3 sentences, human tone.`;

  try {
    if (googleKey) {
      // Use Gemini
      const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleKey}`, {
        contents: [{ parts: [{ text: `${system}\n\nTask: ${prompt}` }] }]
      });
      const text = response.data.candidates[0].content.parts[0].text;
      return res.json({ draft: text.trim() });
    } else {
      // Use Claude (via direct API - needs anthropic-version header)
      const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-3-haiku-20240307',
        max_tokens: 220,
        messages: [{ role: 'user', content: `${system}\n\n${prompt}` }]
      }, {
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      });
      return res.json({ draft: response.data.content[0].text.trim() });
    }
  } catch (error) {
    console.error('AI Generation Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to generate icebreaker' });
  }
});

app.post('/api/send', async (req, res) => {
  const { leadId, method, recipient, subject, content } = req.body;

  if (!method || !recipient) {
    return res.status(400).json({ error: 'method and recipient are required' });
  }

  console.log(`[OUTREACH] Initializing ${method} to ${recipient}...`);

  try {
    if (method === 'whatsapp') {
      if (!whatsappService || !whatsappService.isReady) {
        return res.status(503).json({
          error: 'WhatsApp not available on this server',
          details: 'WhatsApp requires a local server with Chrome installed.'
        });
      }

      const plainTextContent = content.replace(/<[^>]*>/g, '');
      await whatsappService.safeSend(recipient, plainTextContent);

      // Record in Supabase
      if (supabase && leadId) {
        await supabase.from('messages').insert({
          lead_id: leadId,
          content: plainTextContent,
          direction: 'outgoing',
          platform: 'whatsapp'
        });
      }
      
      res.json({
        success: true,
        method: 'whatsapp',
        deliveredAt: new Date().toISOString()
      });
    } else {
      // Real Email Integration (with fallback to simulation if API key is missing)
      const result = await emailService.sendEmail(recipient, subject || 'Partnership Proposal', content);
      
      // Record in Supabase
      if (supabase && leadId) {
        await supabase.from('messages').insert({
          lead_id: leadId,
          content: content,
          direction: 'outgoing',
          platform: 'email'
        });
      }

      res.json({
        success: true,
        method: 'email',
        deliveredAt: new Date().toISOString(),
        details: result.message || 'Sent via Resend'
      });
    }
  } catch (error) {
    console.error('Send error:', error.message);
    res.status(500).json({ error: 'Outreach failed' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    whatsappReady: whatsappService?.isReady || false,
    emailReady: !!process.env.RESEND_API_KEY
  });
});

app.listen(PORT, () => {
  console.log(`Synreach Backend running on port ${PORT}`);
});
