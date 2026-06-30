const form = document.querySelector('#url-form');
const urlInput = document.querySelector('#url-input');
const fetchButton = document.querySelector('#fetch-button');
const formError = document.querySelector('#form-error');
const statusBox = document.querySelector('#status');
const statusText = document.querySelector('#status-text');
const results = document.querySelector('#results');
const emptyState = document.querySelector('#empty-state');
const gallery = document.querySelector('#gallery');
const resultCount = document.querySelector('#result-count');
const selectedCount = document.querySelector('#selected-count');
const selectAllButton = document.querySelector('#select-all');
const clearSelectionButton = document.querySelector('#clear-selection');
const downloadZipButton = document.querySelector('#download-zip');

let images = [];
const selected = new Set();
const EXTRACT_TIMEOUT_MS = 45000;
const ZIP_TIMEOUT_MS = 120000;

function setLoading(isLoading, message = 'Fetching page...') {
  statusBox.hidden = !isLoading;
  statusText.textContent = message;
  fetchButton.disabled = isLoading;
  urlInput.disabled = isLoading;
}

function setError(message) {
  formError.textContent = message || '';
}

function validateUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => window.clearTimeout(timeoutId)
  };
}

function getFriendlyError(error, fallbackMessage) {
  if (error.name === 'AbortError') {
    return 'This request took too long and was stopped. Try a smaller page or another URL.';
  }

  return error.message || fallbackMessage;
}

function updateSelectionUi() {
  const count = selected.size;
  selectedCount.textContent = `${count} selected`;
  selectAllButton.textContent = count === images.length && images.length ? 'Deselect All' : 'Select All';
  downloadZipButton.disabled = count === 0;
  selectAllButton.disabled = images.length === 0;
  clearSelectionButton.disabled = count === 0;

  document.querySelectorAll('.image-card').forEach((card) => {
    const isSelected = selected.has(card.dataset.id);
    card.classList.toggle('selected', isSelected);
    const checkbox = card.querySelector('input[type="checkbox"]');
    checkbox.checked = isSelected;
  });
}

function createImageCard(image) {
  const card = document.createElement('article');
  card.className = 'image-card';
  card.dataset.id = image.id;

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb-wrap';

  const checkbox = document.createElement('input');
  checkbox.className = 'select-box';
  checkbox.type = 'checkbox';
  checkbox.setAttribute('aria-label', `Select ${image.type} image`);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(image.id);
    else selected.delete(image.id);
    updateSelectionUi();
  });

  const img = document.createElement('img');
  img.src = image.previewUrl;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    img.alt = 'Preview unavailable';
    thumbWrap.classList.add('preview-error');
  });

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = image.type.toUpperCase();

  thumbWrap.append(checkbox, img, badge);

  const cardBody = document.createElement('div');
  cardBody.className = 'card-body';

  const imageUrl = document.createElement('p');
  imageUrl.className = 'image-url';
  imageUrl.title = image.url;
  imageUrl.textContent = image.url;

  const source = document.createElement('p');
  source.className = 'source';
  source.textContent = image.source;

  const downloadLink = document.createElement('a');
  downloadLink.className = 'download-link';
  downloadLink.href = image.downloadUrl;
  downloadLink.textContent = 'Download';
  downloadLink.setAttribute('download', '');

  cardBody.append(source, imageUrl, downloadLink);
  card.append(thumbWrap, cardBody);

  card.addEventListener('click', (event) => {
    if (event.target.closest('a') || event.target.closest('input')) return;
    if (selected.has(image.id)) selected.delete(image.id);
    else selected.add(image.id);
    updateSelectionUi();
  });

  return card;
}

function renderImages(nextImages) {
  images = nextImages;
  selected.clear();
  gallery.replaceChildren(...images.map(createImageCard));
  resultCount.textContent = `${images.length} image${images.length === 1 ? '' : 's'} found`;
  results.hidden = images.length === 0;
  emptyState.hidden = images.length > 0;
  updateSelectionUi();
}

async function extractImages(url) {
  const timeout = createTimeoutSignal(EXTRACT_TIMEOUT_MS);

  try {
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: timeout.signal
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Unable to extract images.');
    }

    return payload.images || [];
  } finally {
    timeout.clear();
  }
}

async function downloadZip() {
  const selectedImages = images.filter((image) => selected.has(image.id)).map((image) => image.url);
  if (!selectedImages.length) {
    setError('Select at least one image first.');
    return;
  }

  setError('');
  setLoading(true, 'Creating ZIP...');
  const timeout = createTimeoutSignal(ZIP_TIMEOUT_MS);

  try {
    const response = await fetch('/api/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: selectedImages }),
      signal: timeout.signal
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Unable to create ZIP.');
    }

    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error('The ZIP was empty. Try fewer images or a different page.');
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'images.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    setError(getFriendlyError(error, 'Unable to create ZIP.'));
  } finally {
    timeout.clear();
    setLoading(false);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();

  if (!validateUrl(url)) {
    setError('Enter a valid HTTP or HTTPS URL.');
    return;
  }

  setError('');
  setLoading(true, 'Fetching page and extracting images...');

  try {
    const extractedImages = await extractImages(url);
    renderImages(extractedImages);
    if (!extractedImages.length) {
      setError('No downloadable images were found on that page.');
    }
  } catch (error) {
    renderImages([]);
    setError(getFriendlyError(error, 'Unable to extract images.'));
  } finally {
    setLoading(false);
  }
});

selectAllButton.addEventListener('click', () => {
  if (selected.size === images.length) {
    selected.clear();
  } else {
    images.forEach((image) => selected.add(image.id));
  }
  updateSelectionUi();
});

clearSelectionButton.addEventListener('click', () => {
  selected.clear();
  updateSelectionUi();
});

downloadZipButton.addEventListener('click', downloadZip);
downloadZipButton.disabled = true;
