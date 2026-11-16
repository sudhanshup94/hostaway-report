FROM node:18-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . ./

# Each Cloud Run Job provides REPORT_MODE: operations or portfolio.
CMD ["node", "hostaway-report.js"]
