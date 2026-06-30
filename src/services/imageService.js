const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const { Transform } = require('stream');
const { URL } = require('url');

const REQUEST_TIMEOUT_MS = 12000;
const DNS_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_RESULTS = 500;
const USER_AGENT = 'ImageDownloaderBot/1.0 (+https://localhost)';

const IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp'
]);

function createHttpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(createHttpError(message, 504)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function isPrivateIp(address) {
  if (!address) return true;

  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] === 0
    );
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    );
  }

  return true;
}

async function validatePublicUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw createHttpError('A valid URL is required.');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw createHttpError('Enter a valid absolute website URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw createHttpError('Only HTTP and HTTPS URLs are supported.');
  }

  if (!parsed.hostname || parsed.username || parsed.password) {
    throw createHttpError('The URL format is not supported.');
  }

  const records = await withTimeout(
    dns.lookup(parsed.hostname, { all: true }),
    DNS_TIMEOUT_MS,
    'Timed out while checking the website address. Try again or use a different URL.'
  );
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw createHttpError('Private, local, and internal network URLs are not allowed.', 403);
  }

  return parsed.toString();
}

function absoluteUrl(candidate, baseUrl) {
  if (!candidate || typeof candidate !== 'string') return null;

  const cleaned = candidate.trim().replace(/^['"]|['"]$/g, '');
  if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('blob:') || cleaned.startsWith('javascript:')) {
    return null;
  }

  try {
    const parsed = new URL(cleaned, baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseSrcset(value) {
  if (!value) return [];

  return value
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function parseBackgroundImages(value) {
  if (!value) return [];

  const urls = [];
  const matches = value.matchAll(/url\(([^)]+)\)/gi);
  for (const match of matches) {
    urls.push(match[1]);
  }
  return urls;
}

function extensionFromUrl(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    return path.extname(parsed.pathname).toLowerCase();
  } catch {
    return '';
  }
}

function inferType(imageUrl) {
  const extension = extensionFromUrl(imageUrl).replace('.', '');
  return extension || 'image';
}

function isImageLikeResponse(imageUrl, headers) {
  const contentType = String(headers['content-type'] || '').toLowerCase();
  if (contentType.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(extensionFromUrl(imageUrl));
}

function createLimitStream(maxBytes) {
  let totalBytes = 0;

  return new Transform({
    transform(chunk, encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        callback(createHttpError('Image is larger than the 50 MB download limit.', 413));
        return;
      }
      callback(null, chunk);
    }
  });
}

function pushCandidate(collection, candidate, baseUrl, source) {
  const url = absoluteUrl(candidate, baseUrl);
  if (!url) return;

  const extension = extensionFromUrl(url);
  const isLikelyImage = IMAGE_EXTENSIONS.has(extension) || source !== 'link';
  if (!isLikelyImage) return;

  collection.push({
    url,
    type: inferType(url),
    source
  });
}

function parseImageCandidates(html, url) {
  const $ = cheerio.load(html);
  const candidates = [];

  $('img, source').each((_, element) => {
    const node = $(element);
    ['src', 'data-src', 'data-lazy', 'data-original', 'data-url'].forEach((attr) => {
      pushCandidate(candidates, node.attr(attr), url, attr);
    });
    parseSrcset(node.attr('srcset') || node.attr('data-srcset')).forEach((srcsetUrl) => {
      pushCandidate(candidates, srcsetUrl, url, 'srcset');
    });
  });

  $('[style]').each((_, element) => {
    parseBackgroundImages($(element).attr('style')).forEach((backgroundUrl) => {
      pushCandidate(candidates, backgroundUrl, url, 'background-image');
    });
  });

  $('style').each((_, element) => {
    parseBackgroundImages($(element).html()).forEach((backgroundUrl) => {
      pushCandidate(candidates, backgroundUrl, url, 'background-image');
    });
  });

  $('a[href]').each((_, element) => {
    pushCandidate(candidates, $(element).attr('href'), url, 'link');
  });

  return candidates;
}

function dedupeCandidates(candidates) {
  const unique = new Map();
  for (const candidate of candidates) {
    if (!unique.has(candidate.url)) {
      unique.set(candidate.url, {
        id: Buffer.from(candidate.url).toString('base64url'),
        ...candidate,
        previewUrl: `/api/preview?url=${encodeURIComponent(candidate.url)}`,
        downloadUrl: `/api/download?url=${encodeURIComponent(candidate.url)}`
      });
    }

    if (unique.size >= MAX_RESULTS) break;
  }

  return Array.from(unique.values());
}

async function fetchStaticHtml(url) {
  try {
    const response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxContentLength: MAX_HTML_BYTES,
      responseType: 'text',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      validateStatus: (status) => status >= 200 && status < 400
    });

    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw createHttpError('The URL did not return an HTML page.');
    }

    return response.data;
  } catch (error) {
    if (error.status) throw error;
    if (error.response?.status) {
      throw createHttpError(`The website responded with HTTP ${error.response.status}.`, 502);
    }
    throw createHttpError('Unable to fetch the website. Check the URL and try again.', 502);
  }
}

async function fetchRenderedHtml(url) {
  if (process.env.PLAYWRIGHT_ENABLED !== 'true') {
    return null;
  }

  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    throw createHttpError('Playwright fallback is enabled, but the playwright package is not installed.', 500);
  }

  const browser = await playwright.chromium.launch({
    headless: true
  });

  try {
    const page = await browser.newPage({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 }
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: REQUEST_TIMEOUT_MS });
    return await page.content();
  } finally {
    await browser.close();
  }
}

async function extractImages(rawUrl) {
  const url = await validatePublicUrl(rawUrl);
  const staticHtml = await fetchStaticHtml(url);
  const staticImages = dedupeCandidates(parseImageCandidates(staticHtml, url));

  if (staticImages.length || process.env.PLAYWRIGHT_ENABLED !== 'true') {
    return staticImages;
  }

  const renderedHtml = await fetchRenderedHtml(url);
  if (!renderedHtml) {
    return staticImages;
  }

  return dedupeCandidates(parseImageCandidates(renderedHtml, url));
}

function getRemoteFileName(imageUrl) {
  const fallback = 'image';
  try {
    const parsed = new URL(imageUrl);
    const baseName = path.basename(decodeURIComponent(parsed.pathname)).replace(/[^\w.-]+/g, '-');
    const extension = path.extname(baseName);
    if (baseName && extension) return baseName.slice(0, 120);
    return `${baseName || fallback}.jpg`;
  } catch {
    return `${fallback}.jpg`;
  }
}

async function pipeRemoteFile(imageUrl, res, options = {}) {
  const response = await axios.get(imageUrl, {
    responseType: 'stream',
    timeout: REQUEST_TIMEOUT_MS,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8' },
    validateStatus: (status) => status >= 200 && status < 400
  });

  const contentLength = Number(response.headers['content-length'] || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    response.data.destroy();
    throw createHttpError('Image is larger than the 50 MB download limit.', 413);
  }

  if (!isImageLikeResponse(imageUrl, response.headers)) {
    response.data.destroy();
    throw createHttpError('The remote file is not a supported image.', 415);
  }

  const limitedStream = response.data.pipe(createLimitStream(MAX_IMAGE_BYTES));

  if (options.returnStream) {
    return limitedStream;
  }

  if (response.headers['content-type']) {
    res.setHeader('Content-Type', response.headers['content-type']);
  }
  if (response.headers['content-length']) {
    res.setHeader('Content-Length', response.headers['content-length']);
  }

  return new Promise((resolve, reject) => {
    limitedStream.on('error', reject);
    res.on('close', resolve);
    limitedStream.pipe(res);
  });
}

module.exports = {
  extractImages,
  getRemoteFileName,
  pipeRemoteFile,
  validatePublicUrl
};
