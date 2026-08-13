FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

RUN npx playwright install chromium

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
