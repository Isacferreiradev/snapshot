const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:3001');

  // fill url
  await page.type('#url1', 'https://example.com');
  
  // click capture
  await page.click('#explore-btn');

  // Wait 3 seconds to see what happened
  await new Promise(r => setTimeout(r, 6000));
  
  await page.screenshot({ path: 'test-screenshot.png' });

  await browser.close();
})();
