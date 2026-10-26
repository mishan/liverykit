/**
 * An image's size and whether it carries alpha, read from its own header:
 * DDS and PNG, which a kn5 embeds, and JPEG and WebP, which a glTF often
 * does. Null for anything else, or for too few bytes to say.
 */
export function imageHeader(name, data) {
  if (!data || data.length < 32) return null;
  if (data.toString('ascii', 0, 4) === 'DDS ') {
    if (data.length < 128) return null;           // a header cut short says nothing
    const pfFlags = data.readUInt32LE(80);
    const fourCC = pfFlags & 0x4 ? data.toString('ascii', 84, 88).replace(/\0/g, '') : null;
    return {
      width: data.readUInt32LE(16),
      height: data.readUInt32LE(12),
      mips: data.readUInt32LE(28),
      fourCC,
      alpha: fourCC === 'DXT3' || fourCC === 'DXT5' || (!fourCC && (pfFlags & 0x1) !== 0),
    };
  }
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), fourCC: 'PNG', alpha: true, mips: 1 };
  }
  // A JPEG's size is in its start-of-frame segment, after whatever precedes
  // it; every other segment states its own length.
  if (data[0] === 0xff && data[1] === 0xd8) {
    for (let o = 2; o + 9 < data.length;) {
      if (data[o] !== 0xff) return null;
      if (data[o + 1] === 0xff) { o++; continue; }  // fill before a marker
      const marker = data[o + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: data.readUInt16BE(o + 7), height: data.readUInt16BE(o + 5), fourCC: 'JPEG', alpha: false, mips: 1 };
      }
      o += 2 + data.readUInt16BE(o + 2);
    }
    return null;
  }
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = data.toString('ascii', 12, 16);
    const webp = (width, height, alpha) => ({ width, height, fourCC: 'WEBP', alpha, mips: 1 });
    if (chunk === 'VP8 ') return webp(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff, false);
    if (chunk === 'VP8L') {
      const b = data.readUInt32LE(21);
      return webp((b & 0x3fff) + 1, ((b >>> 14) & 0x3fff) + 1, Boolean((b >>> 28) & 1));
    }
    if (chunk === 'VP8X') return webp(1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3), Boolean(data[20] & 0x10));
  }
  return null;
}
