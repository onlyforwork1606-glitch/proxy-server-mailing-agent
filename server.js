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

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': getAuthHeader()
      }
    });

    const data = await response.json();

    if (!response.ok) {
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

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': getAuthHeader()
      }
    });

    const data = await response.json();

    if (!response.ok) {
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

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': getAuthHeader()
      }
    });

    const data = await response.json();

    if (!response.ok) {
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
  // Always return 200 immediately — no storage
  res.status(200).json({ status: 'ok' });
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
