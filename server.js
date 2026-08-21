const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 4578;
const ROOT = __dirname;
const API_TARGET = 'http://127.0.0.1:3001';

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // Proxy /api/* requests to the GhostCloud API server
  if (req.url.startsWith('/api/')) {
    // Frontend sends /api/cloud/v1/*, backend expects /cloud/v1/*
    const apiPath = req.url.replace('/api', '');
    const targetUrl = API_TARGET + apiPath;
    const proxyReq = http.request(targetUrl, {
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:3001' },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API server unavailable: ' + e.message }));
    });
    req.pipe(proxyReq);
    return;
  }

  // Static file serving
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = filePath.split('?')[0].split('#')[0];
  const fullPath = path.join(ROOT, filePath);
  if (!fullPath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(fullPath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fullPath)] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('GhostCloud game site: http://localhost:' + PORT);
  console.log('API proxy: /api/* → ' + API_TARGET + '/cloud/v1/*');
});
