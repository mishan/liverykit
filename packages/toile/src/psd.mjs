/**
 * The layers of a Photoshop file, as far as a livery template needs them.
 *
 * A game that will not hand over its models hands over templates instead: a
 * PSD per car whose wireframe layer is the UV layout, drawn. The layer is the
 * part worth having; the composite has the publisher's background, logos and
 * fills on it as well, and on the stock car template it has the series decals
 * across the islands. So this reads layers, not the flattened image, and only
 * enough of the format for that: 8-bit RGB or grayscale, stored raw or
 * run-length encoded, which is how Photoshop saves a template. Anything else
 * is refused by name rather than read as noise.
 */

const MODES = { 1: 'grayscale', 3: 'RGB' };

/**
 * { width, height, layers: [{ name, bbox: [left, top, right, bottom], group,
 * alpha() }] }, layers top first as Photoshop lists them.
 * `alpha()` decodes the layer's coverage across the whole sheet, 0 to 255,
 * and is only called for the layer wanted: a template has 25 million pixels
 * per channel.
 */
export function readPsd(buf, { path = 'template' } = {}) {
  if (buf.length < 26 || buf.toString('ascii', 0, 4) !== '8BPS') throw new Error(`${path} is not a Photoshop file`);
  if (buf.readUInt16BE(4) !== 1) throw new Error(`${path} is a large-document file (PSB); save it as a PSD`);
  const height = buf.readUInt32BE(14), width = buf.readUInt32BE(18);
  const depth = buf.readUInt16BE(22), mode = buf.readUInt16BE(24);
  if (depth !== 8) throw new Error(`${path} is ${depth} bits per channel; only 8 is read`);
  if (!MODES[mode]) throw new Error(`${path} is in color mode ${mode}; only RGB and grayscale are read`);

  let o = 26;
  o += 4 + buf.readUInt32BE(o);              // color mode data
  o += 4 + buf.readUInt32BE(o);              // image resources
  const infoEnd = o + 4 + buf.readUInt32BE(o);
  o += 4;
  if (o >= infoEnd) return { width, height, layers: [] };
  o += 4;                                    // layer info length
  const count = Math.abs(buf.readInt16BE(o));
  o += 2;

  const records = [];
  for (let n = 0; n < count; n++) {
    const [top, left, bottom, right] = [0, 4, 8, 12].map((d) => buf.readInt32BE(o + d));
    const nch = buf.readUInt16BE(o + 16);
    o += 18;
    const channels = [];
    for (let c = 0; c < nch; c++) { channels.push({ id: buf.readInt16BE(o), length: buf.readUInt32BE(o + 2) }); o += 6; }
    const extraEnd = o + 16 + buf.readUInt32BE(o + 12);
    let e = o + 16;
    e += 4 + buf.readUInt32BE(e);            // layer mask
    e += 4 + buf.readUInt32BE(e);            // blending ranges
    let name = buf.toString('latin1', e + 1, e + 1 + buf[e]);
    e += (buf[e] + 4) & ~3;
    let group = false;
    // The Pascal name is truncated and in the system's code page; a Unicode
    // copy follows when the name needs one ("Camada 1" is Photoshop in
    // Portuguese, and other templates are not all in English either).
    while (e + 12 <= extraEnd && ['8BIM', '8B64'].includes(buf.toString('ascii', e, e + 4))) {
      const key = buf.toString('ascii', e + 4, e + 8), len = buf.readUInt32BE(e + 8), d = e + 12;
      if (key === 'luni') name = Array.from({ length: buf.readUInt32BE(d) }, (_, i) => String.fromCharCode(buf.readUInt16BE(d + 4 + 2 * i))).join('');
      if (key === 'lsct' || key === 'lsdk') group = buf.readUInt32BE(d) !== 0;
      e = d + len;
    }
    records.push({ name, bbox: [left, top, right, bottom], group, channels });
    o = extraEnd;
  }

  for (const r of records) {
    for (const ch of r.channels) { ch.at = o; o += ch.length; }
    const alpha = r.channels.find((ch) => ch.id === -1);
    r.alpha = () => sheet(buf, r, alpha, width, height, path);
    delete r.channels;
  }
  return { width, height, layers: records.reverse() };
}

/** A layer's transparency channel, placed on the whole sheet. */
function sheet(buf, { name, bbox: [left, top, right, bottom] }, ch, width, height, path) {
  const out = new Uint8Array(width * height);
  const w = right - left, h = bottom - top;
  if (w <= 0 || h <= 0) return out;
  // A layer with no transparency channel covers its whole rectangle.
  const own = ch ? decode(buf, ch, w, h, `${path} layer ${JSON.stringify(name)}`) : new Uint8Array(w * h).fill(255);
  for (let y = Math.max(0, top); y < Math.min(height, bottom); y++) {
    const x0 = Math.max(0, left), x1 = Math.min(width, right);
    out.set(own.subarray((y - top) * w + x0 - left, (y - top) * w + x1 - left), y * width + x0);
  }
  return out;
}

function decode(buf, { at, length }, w, h, what) {
  const kind = buf.readUInt16BE(at);
  if (kind === 0) {
    if (length - 2 < w * h) throw new Error(`${what} is cut short`);
    return new Uint8Array(buf.subarray(at + 2, at + 2 + w * h));
  }
  if (kind !== 1) throw new Error(`${what} is ${kind === 2 || kind === 3 ? 'ZIP' : `type ${kind}`} compressed; save the template from Photoshop with compression off or the default`);
  const out = new Uint8Array(w * h);
  let p = at + 2 + 2 * h;
  for (let y = 0; y < h; y++) {
    const end = p + buf.readUInt16BE(at + 2 + 2 * y);
    let x = y * w;
    const rowEnd = x + w;
    // PackBits: a header n below 128 copies n + 1 bytes, above it repeats
    // the next byte 257 - n times, and 128 is a no-op.
    while (p < end && x < rowEnd) {
      const n = buf[p++];
      if (n < 128) { out.set(buf.subarray(p, p + n + 1).subarray(0, rowEnd - x), x); x += n + 1; p += n + 1; }
      else if (n > 128) { out.fill(buf[p++], x, Math.min(rowEnd, x + 257 - n)); x += 257 - n; }
    }
    if (x < rowEnd) throw new Error(`${what} has a row that ends early`);
    p = end;
  }
  return out;
}
