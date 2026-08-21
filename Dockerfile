FROM node:22-alpine

WORKDIR /app
COPY server.js index.html ./
COPY js/ js/
COPY docs/ docs/
# Ground-truth clips with burned-in frame numbers, for instant verification.
COPY test/frames-30fps.mp4 test/frames-30fps-audio.mp4 test/

# Mount your media read-only at /app/videos and load it as ?src=videos/<file>
# (any path under /app is served, so /app/test works too).

EXPOSE 8417
USER node
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost:8417/status > /dev/null || exit 1
CMD ["node", "server.js", "8417"]
