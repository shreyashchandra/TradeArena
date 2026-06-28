FROM node:22-alpine

WORKDIR /app
COPY package*.json server.js ./
RUN npm ci

EXPOSE 8080
CMD ["npm", "start"]
