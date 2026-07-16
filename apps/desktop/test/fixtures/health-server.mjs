// Minimal stand-in for the real daemon: serves 200 on /api/health on $PORT.
// Used by daemon-supervision.test.js to drive the supervisor's real
// spawn -> unexpected-exit -> respawn -> healthy-again cycle without the full server.
import http from 'node:http';

const port = Number(process.env.PORT);

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'nuncio-health-fixture' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`health-fixture listening ${port}\n`);
});
