# Production build of the SPA, served by nginx; /api is proxied to the backend so the session
# cookie is same-origin (B6). Deep links fall back to index.html.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Environment beats .env files in CRA: the container always talks to the real backend.
ARG REACT_APP_API_MODE=live
ARG REACT_APP_API_BASE_URL=/api/v1
ENV REACT_APP_API_MODE=$REACT_APP_API_MODE \
    REACT_APP_API_BASE_URL=$REACT_APP_API_BASE_URL \
    GENERATE_SOURCEMAP=false
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
