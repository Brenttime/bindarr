'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-model-version-'));
process.env.CV_MODEL_DIR = dir;

const { MODELS, isPresent } = require('../src/utils/modelAssets');
const detector = MODELS.find(model => model.name === 'cornelius.onnx');
const detectorPath = path.join(dir, detector.name);

try {
  fs.writeFileSync(detectorPath, '');
  fs.truncateSync(detectorPath, 4407545);
  assert.strictEqual(isPresent(detector), false, 'the retired detector size must trigger an upgrade');

  fs.truncateSync(detectorPath, detector.bytes);
  assert.strictEqual(isPresent(detector), true, 'the configured detector version should be present');

  fs.truncateSync(detectorPath, detector.bytes - 1);
  assert.strictEqual(isPresent(detector), false, 'a partial detector download must not be accepted');

  console.log('modelassetsversion.test.js: exact-version checks passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
