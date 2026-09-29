const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const size = 256;
const bytes = Buffer.alloc((size * 4 + 1) * size);

function inRoundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function inCapsule(x, y, left, top, right, bottom) {
  const radius = (right - left) / 2;
  if (y >= top + radius && y <= bottom - radius && x >= left && x <= right) return true;
  const cy = y < top + radius ? top + radius : bottom - radius;
  return (x - (left + right) / 2) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

for (let y = 0; y < size; y += 1) {
  const row = y * (size * 4 + 1);
  bytes[row] = 0;
  for (let x = 0; x < size; x += 1) {
    const at = row + 1 + x * 4;
    const tile = inRoundedRect(x, y, 16, 16, 239, 239, 52);
    const mic = inCapsule(x, y, 104, 49, 152, 153);
    const micCutout = inCapsule(x, y, 115, 61, 141, 139);
    const side = ((x >= 82 && x <= 94) || (x >= 162 && x <= 174)) && y >= 113 && y <= 142;
    const curveDistance = Math.hypot(x - 128, y - 139);
    const lowerCurve = y >= 139 && curveDistance >= 34 && curveDistance <= 47;
    const stem = x >= 121 && x <= 135 && y >= 174 && y <= 204;
    const base = x >= 101 && x <= 155 && y >= 197 && y <= 210;
    const white = (mic && !micCutout) || side || lowerCurve || stem || base;

    if (white) {
      bytes[at] = 247; bytes[at + 1] = 251; bytes[at + 2] = 255; bytes[at + 3] = 255;
    } else if (tile) {
      const blend = (x + y) / (size * 2);
      bytes[at] = Math.round(73 - 35 * blend);
      bytes[at + 1] = Math.round(145 - 45 * blend);
      bytes[at + 2] = Math.round(255 - 27 * blend);
      bytes[at + 3] = 255;
    }
  }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(bytes, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader[6] = 0;
icoHeader[7] = 0;
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14);
icoHeader.writeUInt32LE(22, 18);

const target = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, Buffer.concat([icoHeader, png]));
fs.writeFileSync(path.join(path.dirname(target), 'icon.png'), png);
console.log(`Generated ${target}`);
