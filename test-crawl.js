const http = require('http');
const req = http.request(
  { hostname: 'localhost', port: 3001, path: '/api/crawl', method: 'POST', headers: {'Content-Type': 'application/json'} },
  res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      const d = JSON.parse(data);
      console.log('Job:', d);
      if (!d.jobId) return;
      const t = setInterval(() => {
        http.get('http://localhost:3001/api/crawl-status/' + d.jobId, r => {
          let s = '';
          r.on('data', c => s += c);
          r.on('end', () => {
            const status = JSON.parse(s);
            console.log('Status', status);
            if (status.status === 'failed' || (status.pages && status.pages.length > 0)) {
              clearInterval(t);
            }
          })
        })
      }, 1000);
    });
  }
);
req.write(JSON.stringify({url: 'https://example.com'}));
req.end();
