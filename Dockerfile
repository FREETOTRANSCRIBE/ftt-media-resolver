# FreeToTranscribe media-resolver — Node + yt-dlp + ffmpeg
FROM node:20-slim

# ffmpeg (provides ffmpeg + ffprobe) and python (yt-dlp needs it), plus curl to fetch yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp from the official static build, pinned-but-updatable.
# Rebuild the image periodically (or run `yt-dlp -U` on a cron) to stay current.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

# Run as non-root
RUN useradd -m appuser
USER appuser

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
