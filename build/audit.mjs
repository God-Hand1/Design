import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const filesToInspect = [
  'package.json',
  'config/electron-builder.yml',
  'src/main/main.js',
  'src/main/security.js',
  'src/main/download-manager.js',
  'src/preload/preload.js',
  'src/renderer/loading.html',
  'src/renderer/loading.js',
  'src/renderer/hud.html',
  'src/renderer/hud.js'
];

async function read(filePath) {
  return fs.readFile(path.join(rootDir, filePath), 'utf8');
}

async function audit() {
  const findings = [];
  const contents = new Map();

  for (const filePath of filesToInspect) {
    contents.set(filePath, await read(filePath));
  }

  const main = contents.get('src/main/main.js');
  const preload = contents.get('src/preload/preload.js');
  const security = contents.get('src/main/security.js');
  const packageJson = JSON.parse(contents.get('package.json'));
  const builder = contents.get('config/electron-builder.yml');

  if (packageJson.productName !== 'Design Arena') {
    findings.push('package.json productName must be "Design Arena".');
  }

  if (!builder.includes('appId: com.designarena.desktop')) {
    findings.push('electron-builder config must set appId to com.designarena.desktop.');
  }

  for (const required of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true']) {
    if (!main.includes(required)) {
      findings.push(`Main process is missing required hardening option: ${required}`);
    }
  }

  if (!security.includes('setPermissionRequestHandler')) {
    findings.push('Permission request handler is not registered.');
  }

  if (!security.includes('setWindowOpenHandler')) {
    findings.push('Window open handler is not registered.');
  }

  if (!main.includes("session.on('will-download'") && !contents.get('src/main/download-manager.js').includes("session.on('will-download'")) {
    findings.push('Download manager is not using session.on(\'will-download\').');
  }

  if (!preload.includes('contextBridge.exposeInMainWorld')) {
    findings.push('Preload does not expose a constrained bridge.');
  }

  if (/require\s*\(\s*['"]\.\.?\//.test(preload)) {
    findings.push('Sandboxed preload must not require local relative modules.');
  }

  for (const [filePath, source] of contents.entries()) {
    if (/<webview/i.test(source)) {
      findings.push(`${filePath} contains a forbidden <webview> usage.`);
    }
  }

  const unsafeEvalHits = [];
  for (const [filePath, source] of contents.entries()) {
    if (/\beval\s*\(/.test(source)) {
      unsafeEvalHits.push(filePath);
    }
  }

  if (unsafeEvalHits.length > 0) {
    findings.push(`Unexpected eval usage detected in: ${unsafeEvalHits.join(', ')}`);
  }

  if (findings.length > 0) {
    console.error('Static audit failed:\n');
    for (const finding of findings) {
      console.error(`- ${finding}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Static audit passed with 0 findings.');
}

audit().catch((error) => {
  console.error('Static audit crashed:', error);
  process.exitCode = 1;
});
