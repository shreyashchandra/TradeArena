const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const REQUESTS = Number(process.env.REQUESTS || 500);
const CONCURRENCY = Number(process.env.CONCURRENCY || 25);

let completed = 0;
let failed = 0;
let inFlight = 0;
let next = 0;
const started = Date.now();

function requestOnce(id) {
  inFlight += 1;
  const payload = JSON.stringify({
    id: Date.now() * 1000 + id,
    symbol: 'RELIANCE',
    side: id % 2 === 0 ? 'buy' : 'sell',
    type: 'market',
    price: 0,
    quantity: 1,
  });

  const req = http.request(`${BASE_URL}/api/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'x-tradearena-user': 'load-test',
    },
  }, (res) => {
    res.resume();
    res.on('end', () => {
      if (res.statusCode >= 400) failed += 1;
      done();
    });
  });
  req.on('error', () => {
    failed += 1;
    done();
  });
  req.end(payload);
}

function done() {
  completed += 1;
  inFlight -= 1;
  pump();
}

function pump() {
  while (inFlight < CONCURRENCY && next < REQUESTS) {
    requestOnce(next++);
  }
  if (completed === REQUESTS) {
    const seconds = (Date.now() - started) / 1000;
    console.log(JSON.stringify({
      requests: REQUESTS,
      failed,
      seconds,
      rps: Number((REQUESTS / seconds).toFixed(2)),
    }, null, 2));
  }
}

pump();
