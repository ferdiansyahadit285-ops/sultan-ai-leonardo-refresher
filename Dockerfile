FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Salin semua file yang ada (server.js / server-v2.js / package.json)
COPY . .

# Pastikan package.json ada walau file belum diupload
RUN if [ ! -f package.json ]; then \
      echo '{"name":"sultan-leonardo-refresher","private":true,"dependencies":{"express":"^4.21.0","playwright":"1.62.1"}}' > package.json; \
    fi

RUN npm install --omit=dev

# Pakai server.js kalau ada, kalau tidak pakai server-v2.js
RUN if [ ! -f server.js ] && [ -f server-v2.js ]; then cp server-v2.js server.js; fi

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
