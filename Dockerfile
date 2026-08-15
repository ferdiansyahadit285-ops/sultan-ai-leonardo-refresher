FROM mcr.microsoft.com/playwright:v1.62.1-jammy
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
RUN npx playwright install chromium --with-deps || true
COPY server.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
