// build.mjs — esbuild bundler + icon generator for Sonar extension
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watching  = process.argv.includes('--watch');

const DIST = path.join(__dirname, 'dist');
fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(path.join(DIST, 'icons'), { recursive: true });

// ── TypeScript bundles ──────────────────────────────────────────────────────

const base = {
  bundle:    true,
  minify:    !watching,
  sourcemap: watching ? 'inline' : false,
  target:    'chrome120',
  format:    'esm',
  logLevel:  'info',
};

const entryPoints = [
  { in: 'src/background.ts', out: 'dist/background' },
  { in: 'src/content.ts',    out: 'dist/content'    },
  { in: 'src/popup.ts',      out: 'dist/popup'      },
];

if (watching) {
  const ctx = await esbuild.context({ ...base, entryPoints: entryPoints.map(e => e.in), outdir: DIST });
  await ctx.watch();
  console.log('[sonar] Watching for changes…');
} else {
  await Promise.all(
    entryPoints.map(({ in: entry, out }) =>
      esbuild.build({ ...base, entryPoints: [entry], outfile: `${out}.js` }),
    ),
  );
}

// ── Copy static files ────────────────────────────────────────────────────────
function copy(src, dest) {
  const full = path.join(__dirname, src);
  if (fs.existsSync(full)) fs.copyFileSync(full, path.join(DIST, dest));
}
copy('manifest.json', 'manifest.json');
copy('popup.html',    'popup.html');

// ── Generate PNG icons (pure Node.js, no native deps) ────────────────────────
// Produces spec-compliant RGBA PNGs with a black circle + white radar arcs.
// For production-quality icons rendered from icon.svg, run:
//   npx sharp-cli -i icons/icon.svg -o dist/icons/icon{size}.png --resize {size}
// or use any SVG→PNG converter on icons/icon.svg.
{
  console.log('[sonar] Generating PNG icons via pure-Node writer…');
  const zlib = await import('zlib');
  const { promisify } = await import('util');
  const deflate = promisify(zlib.deflate);

  /**
   * Build a minimal, spec-compliant PNG for a black circle with a white
   * dot + two arc segments.  Works for any square size.
   */
  async function makePng(size) {
    // RGBA scanlines
    const imgData = new Uint8Array(size * size * 4);
    const cx = size / 2, cy = size / 2, r = size / 2;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx, dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const idx  = (y * size + x) * 4;

        if (dist > r) {
          // transparent outside circle
          imgData[idx + 3] = 0;
          continue;
        }
        // default: black circle
        imgData[idx]     = 17;
        imgData[idx + 1] = 17;
        imgData[idx + 2] = 17;
        imgData[idx + 3] = 255;

        // White dot in centre (radius = size/12)
        const dotR = size / 12;
        if (dist < dotR) {
          imgData[idx] = imgData[idx + 1] = imgData[idx + 2] = 255;
          continue;
        }
        // White arc strokes (ring at 35%, 50%, 65% radius, top-right quadrant)
        const angle  = Math.atan2(dy, dx);   // –π … π
        const inArc  = angle > -Math.PI * 0.9 && angle < -Math.PI * 0.1;
        const thick  = size / 28;
        if (inArc) {
          for (const ring of [0.35, 0.50, 0.65]) {
            const ringR = r * ring;
            if (Math.abs(dist - ringR) < thick) {
              imgData[idx] = imgData[idx + 1] = imgData[idx + 2] = 255;
              break;
            }
          }
        }
      }
    }

    // PNG encoding: filter byte 0 (None) prepended to each row
    const rawRows = new Uint8Array(size * (1 + size * 4));
    for (let y = 0; y < size; y++) {
      rawRows[y * (1 + size * 4)] = 0;                         // filter = None
      rawRows.set(imgData.subarray(y * size * 4, (y + 1) * size * 4), y * (1 + size * 4) + 1);
    }

    const compressed = await deflate(Buffer.from(rawRows));

    function crc32(buf) {
      let crc = 0xffffffff;
      for (const b of buf) {
        crc ^= b;
        for (let k = 0; k < 8; k++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
      return (crc ^ 0xffffffff) >>> 0;
    }

    function chunk(type, data) {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
      const tBuf = Buffer.from(type, 'ascii');
      const cBuf = Buffer.concat([tBuf, data]);
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(cBuf), 0);
      return Buffer.concat([len, tBuf, data, crcBuf]);
    }

    const sig   = Buffer.from([137,80,78,71,13,10,26,10]);
    const ihdr  = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // colour type: RGBA
    // compression/filter/interlace = 0

    const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
    return png;
  }

  await Promise.all(
    [16, 48, 128].map(async size => {
      const png = await makePng(size);
      fs.writeFileSync(path.join(DIST, 'icons', `icon${size}.png`), png);
    }),
  );
  console.log('[sonar] Fallback icons generated ✓');
}

if (!watching) console.log('[sonar] Build complete → dist/');
