const express = require('express');
const archiver = require('archiver');
const {
  extractImages,
  getRemoteFileName,
  pipeRemoteFile,
  validatePublicUrl
} = require('../services/imageService');

const router = express.Router();

router.post('/extract', async (req, res, next) => {
  try {
    const { url } = req.body || {};
    const images = await extractImages(url);
    res.json({ sourceUrl: url, count: images.length, images });
  } catch (error) {
    next(error);
  }
});

router.get('/download', async (req, res, next) => {
  try {
    const url = await validatePublicUrl(req.query.url);
    const fileName = getRemoteFileName(url);

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await pipeRemoteFile(url, res);
  } catch (error) {
    next(error);
  }
});

router.get('/preview', async (req, res, next) => {
  try {
    const url = await validatePublicUrl(req.query.url);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    await pipeRemoteFile(url, res);
  } catch (error) {
    next(error);
  }
});

router.post('/zip', async (req, res, next) => {
  try {
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!images.length) {
      const error = new Error('Select at least one image to download as ZIP.');
      error.status = 400;
      throw error;
    }

    if (images.length > 200) {
      const error = new Error('ZIP downloads are limited to 200 images at a time.');
      error.status = 413;
      throw error;
    }

    const urls = [];
    for (const imageUrl of images) {
      urls.push(await validatePublicUrl(imageUrl));
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="images.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', next);
    archive.pipe(res);

    for (let index = 0; index < urls.length; index += 1) {
      try {
        const url = urls[index];
        const stream = await pipeRemoteFile(url, null, { returnStream: true });
        archive.append(stream, { name: `${String(index + 1).padStart(3, '0')}-${getRemoteFileName(url)}` });
      } catch (error) {
        archive.append(`Skipped: ${urls[index]}\nReason: ${error.message}\n`, {
          name: `${String(index + 1).padStart(3, '0')}-download-error.txt`
        });
      }
    }

    await archive.finalize();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
