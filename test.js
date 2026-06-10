const express = require('express');
const http = require('http');

// Mock global fetch before importing or starting anything
let lastFetchCall = null;
let mockFetchResponse = {
  ok: true,
  status: 200,
  json: async () => ({ success: true, mocked: true })
};

globalThis.fetch = async (url, options) => {
  lastFetchCall = { url, options };
  return mockFetchResponse;
};

// Mock process.env
process.env.ZEPTO_API_KEY = 'test_api_key_12345';
process.env.ALLOWED_ORIGIN = 'https://test-frontend.com';
process.env.PORT = '0'; // random port

// Import the server code
// Note: server.js starts the server directly on app.listen(PORT).
// To prevent port collision or test cleanly, we can intercept listen or just import it.
// Let's run a test server instance. Since server.js runs automatically on import,
// let's require it and capture the server instance, or inspect it.
console.log('Starting verification test suite...');

// We need to fetch from the local server. Since we started it on PORT = 0 (or a random port),
// let's wait a moment for it to start.
// Wait, does server.js export anything? No, but it calls app.listen.
// Let's check which port it actually bound to. To do this cleanly, we can override app.listen in express!
const originalListen = express.application.listen;
let serverInstance = null;
let boundPort = null;

express.application.listen = function(port, cb) {
  serverInstance = originalListen.call(this, 0, function() {
    boundPort = serverInstance.address().port;
    console.log(`Test server bound to port: ${boundPort}`);
    if (cb) cb();
    runTests();
  });
  return serverInstance;
};

// Load the server
require('./server.js');

async function makeRequest(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${boundPort}${path}`, {
      headers: {
        'Origin': 'https://test-frontend.com'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: JSON.parse(data)
        });
      });
    }).on('error', reject);
  });
}

async function runTests() {
  try {
    // ----------------------------------------------------
    // Test 1: Health Check Endpoint
    // ----------------------------------------------------
    console.log('\n--- Running Test 1: Health Check ---');
    const healthRes = await makeRequest('/health');
    if (healthRes.statusCode !== 200 || healthRes.body.status !== 'healthy') {
      throw new Error(`Health check failed: ${JSON.stringify(healthRes)}`);
    }
    console.log('✓ Health check passed');

    // ----------------------------------------------------
    // Test 2: GET /api/zepto/stats
    // ----------------------------------------------------
    console.log('\n--- Running Test 2: Stats Route ---');
    lastFetchCall = null;
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ total: 100, delivered: 95, opens: 50, clicks: 20, bounces: 5 })
    };

    const statsRes = await makeRequest('/api/zepto/stats?mailagent_key=agent_abc');
    
    if (statsRes.statusCode !== 200) {
      throw new Error(`Stats endpoint failed with code ${statsRes.statusCode}`);
    }
    if (!lastFetchCall) {
      throw new Error('Stats request did not trigger outgoing fetch call');
    }
    
    const statsUrl = new URL(lastFetchCall.url);
    if (statsUrl.pathname !== '/v1.1/email/stats' || statsUrl.searchParams.get('mailagent_key') !== 'agent_abc') {
      throw new Error(`Stats URL or query mapping incorrect: ${lastFetchCall.url}`);
    }
    if (lastFetchCall.options.headers['Authorization'] !== 'Zoho-enczapikey test_api_key_12345') {
      throw new Error(`Authorization header incorrect: ${JSON.stringify(lastFetchCall.options.headers)}`);
    }
    console.log('✓ Stats route mapping passed');

    // ----------------------------------------------------
    // Test 3: GET /api/zepto/emails with status and pagination
    // ----------------------------------------------------
    console.log('\n--- Running Test 3: Emails Route with Parameter Mapping ---');
    lastFetchCall = null;
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({ data: [] })
    };

    const emailsRes = await makeRequest('/api/zepto/emails?page=3&limit=10&status=failed&mailagent_key=my_agent');
    
    if (emailsRes.statusCode !== 200) {
      throw new Error(`Emails route failed with code ${emailsRes.statusCode}`);
    }
    
    const emailsUrl = new URL(lastFetchCall.url);
    if (emailsUrl.pathname !== '/v1.1/email') {
      throw new Error(`Emails route target path incorrect: ${lastFetchCall.url}`);
    }
    
    // Check pagination mapping: page=3, limit=10 -> offset=20, limit=10
    if (emailsUrl.searchParams.get('limit') !== '10' || emailsUrl.searchParams.get('offset') !== '20') {
      throw new Error(`Pagination mapping incorrect. Expected limit=10 offset=20, got: ${emailsUrl.search}`);
    }
    
    // Check status mapping: status=failed -> is_mailfailure=true
    if (emailsUrl.searchParams.get('is_mailfailure') !== 'true') {
      throw new Error(`Status mapping incorrect. Expected is_mailfailure=true, got: ${emailsUrl.search}`);
    }
    
    // Check forwarded parameters
    if (emailsUrl.searchParams.get('mailagent_key') !== 'my_agent') {
      throw new Error(`Forwarded parameter missing or incorrect: ${emailsUrl.search}`);
    }
    console.log('✓ Emails route parameter mapping passed');

    // ----------------------------------------------------
    // Test 4: GET /api/zepto/bounces
    // ----------------------------------------------------
    console.log('\n--- Running Test 4: Bounces Route ---');
    lastFetchCall = null;
    const bouncesRes = await makeRequest('/api/zepto/bounces?page=1&limit=25&mailagent_key=my_agent');
    
    if (bouncesRes.statusCode !== 200) {
      throw new Error(`Bounces route failed with code ${bouncesRes.statusCode}`);
    }
    
    const bouncesUrl = new URL(lastFetchCall.url);
    if (bouncesUrl.searchParams.get('is_hb') !== 'true' || bouncesUrl.searchParams.get('is_sb') !== 'true') {
      throw new Error(`Bounce parameters missing: ${bouncesUrl.search}`);
    }
    console.log('✓ Bounces route passed');

    // ----------------------------------------------------
    // Test 5: Error Propagation
    // ----------------------------------------------------
    console.log('\n--- Running Test 5: Error Propagation ---');
    lastFetchCall = null;
    mockFetchResponse = {
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid API key' })
    };

    const errRes = await makeRequest('/api/zepto/stats');
    
    if (errRes.statusCode !== 401) {
      throw new Error(`Expected error status 401, got ${errRes.statusCode}`);
    }
    if (errRes.body.error !== 'invalid API key') {
      throw new Error(`Expected error body message 'invalid API key', got: ${JSON.stringify(errRes.body)}`);
    }
    console.log('✓ Error propagation passed');

    console.log('\n=======================================');
    console.log('ALL VERIFICATION TESTS PASSED SUCCESSFULLY!');
    console.log('=======================================');
    
    // Shutdown server
    serverInstance.close(() => {
      process.exit(0);
    });
  } catch (err) {
    console.error('\n❌ VERIFICATION TEST FAILED:', err.message);
    if (serverInstance) {
      serverInstance.close(() => {
        process.exit(1);
      });
    } else {
      process.exit(1);
    }
  }
}
