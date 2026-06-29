# Image Downloader

A production-ready Node.js and Express web app for extracting images and GIFs from a public website, previewing them in a responsive gallery, selecting individual images, and downloading one file or a ZIP bundle.

## Features

- Validates public HTTP/HTTPS website URLs.
- Extracts image candidates from `img`, `source`, `srcset`, `data-src`, `data-lazy`, `data-original`, inline `background-image`, stylesheet `url(...)`, direct image links, and GIF URLs.
- Converts relative image URLs to absolute URLs.
- Removes duplicate images.
- Proxies previews through the backend to reduce browser CORS issues.
- Supports individual image downloads.
- Supports selected image ZIP downloads.
- Includes loading, selection, empty, and error states.
- Responsive gallery UI built with plain HTML, CSS, and JavaScript.

## Folder Structure

```text
.
├── package.json
├── Procfile
├── README.md
├── render.yaml
├── server.js
├── public
│   ├── favicon.svg
│   ├── app.js
│   ├── index.html
│   └── styles.css
└── src
    ├── routes
    │   └── images.js
    └── services
        └── imageService.js
```

## Installation

```bash
npm install
```

## Run Commands

Development mode:

```bash
npm run dev
```

Production mode:

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

## Publish Online

This app needs a Node.js host because image extraction and ZIP creation run on the Express backend.

### Option 1: Render

1. Push this project to a GitHub repository.
2. Create a new Render Web Service from that repository.
3. Render can read `render.yaml`, or you can enter these settings manually:

```text
Environment: Node
Build Command: npm ci
Start Command: npm start
```

4. After deploy, Render will give you a public URL such as:

```text
https://your-service-name.onrender.com
```

### Option 2: Any Node Host

Use these settings on Railway, Fly.io, Heroku-compatible hosts, or a VPS:

```text
Install: npm ci
Start: npm start
Port: use the host-provided PORT environment variable
```

### Option 3: Docker

Build and run locally:

```bash
docker build -t image-downloader .
docker run -p 3000:3000 image-downloader
```

Deploy the same Docker image to any container host.

## Notes

- The app blocks private, local, and internal network targets to reduce SSRF risk.
- ZIP downloads are limited to 200 selected images, and individual image streams are limited to 50 MB.
- The default scraper uses Axios and Cheerio. For JavaScript-rendered pages, install Playwright and start with `PLAYWRIGHT_ENABLED=true npm start`; the backend will render pages with Chromium only when the static HTML path finds no images.

Optional Playwright setup:

```bash
npm install playwright
npx playwright install chromium
PLAYWRIGHT_ENABLED=true npm start
```
