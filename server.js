require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const ZEPTO_BASE_URL = process.env.ZEPTO_API_URL || 'https://api.zeptomail.com/v1.1';

// CORS configuration: restrict access to process.env.ALLOWED_ORIGIN or local environments
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. curl or internal tests)
    if (!origin) return callback(null, true);

    // If ALLOWED_ORIGIN is '*', allow everything
    if (allowedOrigin === '*') return callback(null, true);

    // Support comma-separated origins
    const allowedOrigins = allowedOrigin ? allowedOrigin.split(',').map(o => o.trim()) : [];
    
    // Always allow localhost/127.0.0.1 for local testing
    const isLocalhost = origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');

    if (allowedOrigins.includes(origin) || isLocalhost) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Utility helper to get authorization header
function getAuthHeader() {
  const apiKey = process.env.ZEPTO_API_KEY;
  if (!apiKey) {
    throw new Error('ZEPTO_API_KEY is not defined in environment variables');
  }
  // Prepend Zoho-enczapikey if not already present
  if (apiKey.startsWith('Zoho-enczapikey ')) {
    return apiKey;
  }
  return `Zoho-enczapikey ${apiKey}`;
}

// --- Webhook Memory Store & Helpers ---
const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, 'webhook_data.json');

let webhookStats = {
  total: 0,
  delivered: 0,
  opens: 0,
  clicks: 0,
  soft_bounces: 0,
  hard_bounces: 0,
  feedback_loops: 0
};
let webhookEmails = [];
let webhookBounces = new Set();

// Helper to combine in-memory webhook stats with seeds (from environment variables)
function getCombinedStats() {
  return {
    total: webhookStats.total + parseInt(process.env.SEED_TOTAL || '0', 10),
    delivered: webhookStats.delivered + parseInt(process.env.SEED_DELIVERED || '0', 10),
    opens: webhookStats.opens + parseInt(process.env.SEED_OPENS || '0', 10),
    clicks: webhookStats.clicks + parseInt(process.env.SEED_CLICKS || '0', 10),
    soft_bounces: webhookStats.soft_bounces + parseInt(process.env.SEED_SOFT_BOUNCES || '0', 10),
    hard_bounces: webhookStats.hard_bounces + parseInt(process.env.SEED_HARD_BOUNCES || '0', 10),
    feedback_loops: webhookStats.feedback_loops + parseInt(process.env.SEED_FEEDBACK_LOOPS || '0', 10)
  };
}

// Load cached webhook events if file exists
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    webhookStats = parsed.stats || webhookStats;
    webhookEmails = parsed.emails || webhookEmails;
    webhookBounces = new Set(parsed.bounces || []);
    console.log(`Loaded ${webhookEmails.length} emails and ${webhookBounces.size} bounces from local cache.`);
  } catch (e) {
    console.error('Failed to load webhook data file:', e);
  }
}

// Save webhook events to file
function saveWebhookData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      stats: webhookStats,
      emails: webhookEmails,
      bounces: Array.from(webhookBounces)
    }, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save webhook data file:', e);
  }
}

// Process single or batched webhook events from ZeptoMail
function processWebhookEvent(body) {
  const events = Array.isArray(body) ? body : [body];
  let updated = false;

  for (const event of events) {
    if (!event) continue;

    // Detect event type from common fields
    const eventType = event.event || event.object || (event.event_data && (event.event_data.event || event.event_data.object));
    if (!eventType) {
      console.warn('Unknown event structure (no event type found):', event);
      continue;
    }

    const data = event.event_data || event;
    const msgId = data.message_id || data.request_id || event.message_id || event.request_id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    // Normalize recipient
    let recipient = '';
    if (data.to) {
      if (Array.isArray(data.to)) {
        recipient = data.to.map(t => typeof t === 'object' ? (t.email_address || '') : String(t)).join(', ');
      } else if (typeof data.to === 'object') {
        recipient = data.to.email_address || '';
      } else {
        recipient = String(data.to);
      }
    } else if (data.email) {
      recipient = String(data.email);
    } else if (data.fblFrom) {
      recipient = String(data.fblFrom);
    } else if (event.email) {
      recipient = String(event.email);
    }

    const sender = data.from || event.from || '';
    const subject = data.subject || event.subject || '';
    const timestamp = data.timestamp || data.processed_time || data.time || event.timestamp || event.processed_time || new Date().toISOString();
    const typeLower = eventType.toLowerCase();

    let emailLog = webhookEmails.find(e => e.message_id === msgId);

    if (!emailLog) {
      emailLog = {
        message_id: msgId,
        to_address: recipient,
        from_address: sender,
        subject: subject,
        status: 'processed',
        opens: 0,
        clicks: 0,
        timestamp: timestamp
      };
      webhookEmails.unshift(emailLog);
      webhookStats.total++;
      updated = true;
    }

    if (typeLower.includes('processed') || typeLower.includes('sent') || typeLower.includes('delivered')) {
      emailLog.status = 'delivered';
      webhookStats.delivered++;
      updated = true;
    } else if (typeLower.includes('open')) {
      emailLog.opens++;
      if (emailLog.status !== 'clicked' && !emailLog.status.includes('bounce')) {
        emailLog.status = 'opened';
      }
      webhookStats.opens++;
      updated = true;
    } else if (typeLower.includes('click')) {
      emailLog.clicks++;
      if (!emailLog.status.includes('bounce')) {
        emailLog.status = 'clicked';
      }
      webhookStats.clicks++;
      updated = true;
    } else if (typeLower.includes('bounce')) {
      const isHard = typeLower.includes('hard') || (data.category && data.category.toLowerCase().includes('hard'));
      if (isHard) {
        emailLog.status = 'hardbounce';
        webhookStats.hard_bounces++;
      } else {
        emailLog.status = 'softbounce';
        webhookStats.soft_bounces++;
      }
      if (recipient) {
        webhookBounces.add(recipient);
      }
      updated = true;
    } else if (typeLower.includes('complaint') || typeLower.includes('fbl')) {
      emailLog.status = 'complaint';
      webhookStats.feedback_loops++;
      updated = true;
    }
  }

  if (updated) {
    saveWebhookData();
  }
}
// -------------------------------------

// Health Check Endpoint (useful for Render deployment checks)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

/**
 * GET /api/zepto/stats
 * Calls ZeptoMail API: GET https://api.zeptomail.com/v1.1/email/stats
 * Returns aggregate counts: total, delivered, opens, clicks, bounces
 */
app.get('/api/zepto/stats', async (req, res, next) => {
  try {
    const query = new URLSearchParams(req.query).toString();
    const url = `${ZEPTO_BASE_URL}/email/stats${query ? '?' + query : ''}`;

    console.log(`Forwarding stats request to ZeptoMail: ${url}`);

    let response;
    let data;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': getAuthHeader()
        }
      });
      data = await response.json();
    } catch (fetchErr) {
      console.warn('ZeptoMail API stats fetch failed, falling back to in-memory webhook stats:', fetchErr.message);
      return res.json({ data: getCombinedStats() });
    }

    if (!response.ok) {
      const errMsg = (data && (data.error_message || data.message || (data.error && data.error.message))) || '';
      const isAuthError = response.status === 401 || response.status === 403 || response.status === 404 || errMsg.toLowerCase().includes('access') || errMsg.toLowerCase().includes('token');
      
      if (isAuthError) {
        console.warn(`ZeptoMail API returned ${response.status} (${errMsg}). Falling back to in-memory webhook stats.`);
        return res.json({ data: getCombinedStats() });
      }
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/zepto/emails
 * Calls ZeptoMail API: GET https://api.zeptomail.com/v1.1/email
 * Supports filter params: status, date_from, date_to
 */
app.get('/api/zepto/emails', async (req, res, next) => {
  try {
    const { page, limit, status, date_from, date_to, ...otherParams } = req.query;
    
    // Inline function to return the local fallback data filtered & paginated
    const handleFallback = () => {
      let filtered = [...webhookEmails];
      
      // Status filtering
      if (status && status !== 'all') {
        const lowerStatus = status.toString().toLowerCase();
        if (lowerStatus === 'delivered') {
          filtered = filtered.filter(e => e.status === 'delivered');
        } else if (lowerStatus === 'failed' || lowerStatus === 'failure' || lowerStatus === 'bounce' || lowerStatus === 'bounces' || lowerStatus === 'softbounce' || lowerStatus === 'hardbounce') {
          filtered = filtered.filter(e => e.status.includes('bounce'));
        } else if (lowerStatus === 'opened' || lowerStatus === 'open') {
          filtered = filtered.filter(e => e.status === 'opened');
        } else if (lowerStatus === 'clicked' || lowerStatus === 'click') {
          filtered = filtered.filter(e => e.status === 'clicked');
        }
      }
      
      // Date filtering
      if (date_from) {
        const fromDate = new Date(date_from);
        filtered = filtered.filter(e => new Date(e.timestamp) >= fromDate);
      }
      if (date_to) {
        const toDate = new Date(date_to);
        filtered = filtered.filter(e => new Date(e.timestamp) <= toDate);
      }
      
      const parsedLimit = parseInt(limit, 10) || 25;
      const parsedPage = parseInt(page, 10) || 1;
      const offset = (parsedPage - 1) * parsedLimit;
      const paginated = filtered.slice(offset, offset + parsedLimit);
      
      return res.json({
        data: paginated,
        total_count: filtered.length
      });
    };

    const queryParams = new URLSearchParams();

    // Map pagination parameters: page & limit -> offset & limit
    const parsedLimit = parseInt(limit, 10) || 25;
    const parsedPage = parseInt(page, 10) || 1;
    const offset = (parsedPage - 1) * parsedLimit;

    queryParams.append('limit', parsedLimit.toString());
    queryParams.append('offset', offset.toString());

    // Map status filter
    if (status && status !== 'all') {
      const lowerStatus = status.toString().toLowerCase();
      if (lowerStatus === 'delivered') {
        queryParams.append('is_delivered', 'true');
      } else if (lowerStatus === 'failed' || lowerStatus === 'failure') {
        queryParams.append('is_mailfailure', 'true');
      } else if (lowerStatus === 'bounce' || lowerStatus === 'bounces') {
        queryParams.append('is_hb', 'true');
        queryParams.append('is_sb', 'true');
      }
    }

    // Map date filters
    if (date_from) queryParams.append('date_from', date_from.toString());
    if (date_to) queryParams.append('date_to', date_to.toString());

    // Forward all other query parameters (e.g. mailagent_key, request_id)
    Object.entries(otherParams).forEach(([key, val]) => {
      if (val !== undefined && val !== null) {
        queryParams.append(key, val.toString());
      }
    });

    const url = `${ZEPTO_BASE_URL}/email?${queryParams.toString()}`;
    console.log(`Forwarding email logs request to ZeptoMail: ${url}`);

    let response;
    let data;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': getAuthHeader()
        }
      });
      data = await response.json();
    } catch (fetchErr) {
      console.warn('ZeptoMail API emails fetch failed, falling back to in-memory webhook logs:', fetchErr.message);
      return handleFallback();
    }

    if (!response.ok) {
      const errMsg = (data && (data.error_message || data.message || (data.error && data.error.message))) || '';
      const isAuthError = response.status === 401 || response.status === 403 || response.status === 404 || errMsg.toLowerCase().includes('access') || errMsg.toLowerCase().includes('token');
      
      if (isAuthError) {
        console.warn(`ZeptoMail API returned ${response.status} (${errMsg}). Falling back to in-memory webhook logs.`);
        return handleFallback();
      }
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/zepto/bounces
 * Calls ZeptoMail API for bounce-specific records (is_hb=true & is_sb=true)
 */
app.get('/api/zepto/bounces', async (req, res, next) => {
  try {
    const { page, limit, date_from, date_to, ...otherParams } = req.query;
    
    // Inline function for local fallback
    const handleFallback = () => {
      const bouncesList = Array.from(webhookBounces).map(email => {
        const log = webhookEmails.find(e => e.to_address === email);
        return {
          message_id: log ? log.message_id : `b_${Math.random().toString(36).substr(2, 5)}`,
          to_address: email,
          from_address: log ? log.from_address : '',
          subject: log ? log.subject : '',
          status: log ? log.status : 'hardbounce',
          timestamp: log ? log.timestamp : new Date().toISOString()
        };
      });

      const parsedLimit = parseInt(limit, 10) || 25;
      const parsedPage = parseInt(page, 10) || 1;
      const offset = (parsedPage - 1) * parsedLimit;
      const paginated = bouncesList.slice(offset, offset + parsedLimit);
      
      return res.json({
        data: paginated,
        total_count: bouncesList.length
      });
    };

    const queryParams = new URLSearchParams();

    // Map pagination parameters
    const parsedLimit = parseInt(limit, 10) || 25;
    const parsedPage = parseInt(page, 10) || 1;
    const offset = (parsedPage - 1) * parsedLimit;

    queryParams.append('limit', parsedLimit.toString());
    queryParams.append('offset', offset.toString());

    // Filter specifically for bounces (hard bounce and soft bounce)
    queryParams.append('is_hb', 'true');
    queryParams.append('is_sb', 'true');

    // Map date filters
    if (date_from) queryParams.append('date_from', date_from.toString());
    if (date_to) queryParams.append('date_to', date_to.toString());

    // Forward all other query parameters (e.g. mailagent_key)
    Object.entries(otherParams).forEach(([key, val]) => {
      if (val !== undefined && val !== null) {
        queryParams.append(key, val.toString());
      }
    });

    const url = `${ZEPTO_BASE_URL}/email?${queryParams.toString()}`;
    console.log(`Forwarding bounces request to ZeptoMail: ${url}`);

    let response;
    let data;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': getAuthHeader()
        }
      });
      data = await response.json();
    } catch (fetchErr) {
      console.warn('ZeptoMail API bounces fetch failed, falling back to in-memory webhook bounces:', fetchErr.message);
      return handleFallback();
    }

    if (!response.ok) {
      const errMsg = (data && (data.error_message || data.message || (data.error && data.error.message))) || '';
      const isAuthError = response.status === 401 || response.status === 403 || response.status === 404 || errMsg.toLowerCase().includes('access') || errMsg.toLowerCase().includes('token');
      
      if (isAuthError) {
        console.warn(`ZeptoMail API returned ${response.status} (${errMsg}). Falling back to in-memory webhook bounces.`);
        return handleFallback();
      }
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Parse JSON bodies (needed for webhook POST route)
app.use(express.json());

// Webhook receiver for ZeptoMail events
app.post('/webhooks/zepto', (req, res) => {
  console.log('Received ZeptoMail Webhook Event POST:', JSON.stringify(req.body, null, 2));
  try {
    processWebhookEvent(req.body);
    res.status(200).json({ status: 'ok', message: 'Event processed' });
  } catch (e) {
    console.error('Error processing ZeptoMail webhook event:', e.message);
    res.status(500).json({ error: 'Failed to process event' });
  }
});

// Error handling middleware: forwards original status code and returns { error }
app.use((err, req, res, next) => {
  console.error('Proxy server encountered error:', err.message || err);
  
  const statusCode = err.status || err.statusCode || 500;
  const message = err.message || 'An unexpected error occurred in the proxy server';
  
  res.status(statusCode).json({ error: message });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Stateless ZeptoMail Proxy Server listening on port ${PORT}`);
  console.log(`ZeptoMail Target Base URL: ${ZEPTO_BASE_URL}`);
  console.log(`Allowed Origin: ${allowedOrigin || '*'}`);
});
