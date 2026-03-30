FROM ghcr.io/puppeteer/puppeteer:22

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

USER root
RUN mkdir -p data data-seed screenshots && chmod -R 777 data data-seed screenshots
USER pptruser

EXPOSE 3001

CMD ["node", "server.js"]
