import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Icns, IcnsImage } from '@fiahfy/icns';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const sourceSvg = path.join(rootDir, 'src', 'assets', 'icon.svg');
const outputDir = path.join(rootDir, 'build', 'icons');

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

const icnsTypes = [
  [16, 'icp4'],
  [32, 'ic11'],
  [32, 'icp5'],
  [64, 'ic12'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic13'],
  [256, 'ic08'],
  [512, 'ic14'],
  [512, 'ic09'],
  [1024, 'ic10']
];

async function renderPng(size) {
  return sharp(sourceSvg, { density: 768 })
    .resize(size, size, { fit: 'contain' })
    .png()
    .toBuffer();
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });

  const pngBuffers = new Map();

  for (const size of sizes) {
    const buffer = await renderPng(size);
    pngBuffers.set(size, buffer);
    await fs.writeFile(path.join(outputDir, `icon-${size}.png`), buffer);
  }

  await fs.writeFile(path.join(outputDir, 'icon.png'), pngBuffers.get(1024));

  const icoBuffer = await pngToIco(
    [16, 24, 32, 48, 64, 128, 256].map((size) => pngBuffers.get(size))
  );
  await fs.writeFile(path.join(outputDir, 'icon.ico'), icoBuffer);

  const icns = new Icns();
  for (const [size, type] of icnsTypes) {
    icns.append(IcnsImage.fromPNG(pngBuffers.get(size), type));
  }
  await fs.writeFile(path.join(outputDir, 'icon.icns'), icns.data);
}

main().catch((error) => {
  console.error('[icon-gen] Failed to generate icons:', error);
  process.exitCode = 1;
});
