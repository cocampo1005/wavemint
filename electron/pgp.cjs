// Minimal OpenPGP detached-signature verification (RFC 4880) using only
// Node's crypto module. It supports exactly what yt-dlp's release signing
// uses: a v4 RSA public key and v4 RSA signatures over a binary document
// (signature type 0x00) with a SHA-256/384/512 digest.
//
// This is deliberately narrow. Anything else (other key or signature
// versions, algorithms, signature types, or a key whose fingerprint does not
// match the pinned one) is rejected rather than interpreted.

const crypto = require("crypto");

const PUBLIC_KEY_TAG = 6;
const SIGNATURE_TAG = 2;
const RSA_ALGORITHMS = new Set([1, 3]); // RSA (sign/encrypt), RSA sign-only
const HASH_ALGORITHMS = { 8: "sha256", 9: "sha384", 10: "sha512" };
const ISSUER_FINGERPRINT_SUBPACKET = 33;
const SIGNATURE_CREATION_SUBPACKET = 2;

class SignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = "SignatureError";
  }
}

function dearmor(text) {
  const lines = String(text || "").split(/\r?\n/);
  const begin = lines.findIndex((line) => /^-----BEGIN PGP [A-Z ]+-----$/.test(line));
  const end = lines.findIndex((line) => /^-----END PGP [A-Z ]+-----$/.test(line));

  if (begin < 0 || end < begin) {
    throw new SignatureError("Not an ASCII-armored OpenPGP block");
  }

  let body = lines.slice(begin + 1, end);
  const blank = body.findIndex((line) => !line.trim());
  if (blank >= 0) body = body.slice(blank + 1); // skip armor headers
  body = body.filter((line) => line.trim() && !line.startsWith("="));

  return Buffer.from(body.join(""), "base64");
}

function readPackets(buffer) {
  const packets = [];
  let offset = 0;

  while (offset < buffer.length) {
    const header = buffer[offset];
    if (!(header & 0x80)) throw new SignatureError("Malformed OpenPGP packet");

    let tag;
    let length;
    let bodyStart;

    if (header & 0x40) {
      // New-format packet header.
      tag = header & 0x3f;
      const first = buffer[offset + 1];
      if (first < 192) {
        length = first;
        bodyStart = offset + 2;
      } else if (first < 224) {
        length = ((first - 192) << 8) + buffer[offset + 2] + 192;
        bodyStart = offset + 3;
      } else if (first === 255) {
        length = buffer.readUInt32BE(offset + 2);
        bodyStart = offset + 6;
      } else {
        throw new SignatureError("Partial-length OpenPGP packets are not supported");
      }
    } else {
      // Old-format packet header.
      tag = (header >> 2) & 0x0f;
      const lengthType = header & 0x03;
      if (lengthType === 0) {
        length = buffer[offset + 1];
        bodyStart = offset + 2;
      } else if (lengthType === 1) {
        length = buffer.readUInt16BE(offset + 1);
        bodyStart = offset + 3;
      } else if (lengthType === 2) {
        length = buffer.readUInt32BE(offset + 1);
        bodyStart = offset + 5;
      } else {
        throw new SignatureError("Indeterminate-length OpenPGP packets are not supported");
      }
    }

    if (bodyStart + length > buffer.length) {
      throw new SignatureError("Truncated OpenPGP packet");
    }

    packets.push({ tag, body: buffer.subarray(bodyStart, bodyStart + length) });
    offset = bodyStart + length;
  }

  return packets;
}

// Reads a multiprecision integer; returns its bytes and the next offset.
function readMpi(buffer, offset) {
  const bits = buffer.readUInt16BE(offset);
  const byteLength = Math.ceil(bits / 8);
  const start = offset + 2;
  if (start + byteLength > buffer.length) throw new SignatureError("Truncated MPI");
  return { value: buffer.subarray(start, start + byteLength), next: start + byteLength };
}

function toBase64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Parses an armored or binary OpenPGP public key and returns its primary RSA
 * key as a Node KeyObject together with the v4 fingerprint (uppercase hex).
 */
function parsePublicKey(keyData) {
  const buffer = Buffer.isBuffer(keyData) ? keyData : dearmor(keyData);
  const packet = readPackets(buffer).find((item) => item.tag === PUBLIC_KEY_TAG);
  if (!packet) throw new SignatureError("No public key packet found");

  const body = packet.body;
  if (body[0] !== 4) throw new SignatureError("Only v4 OpenPGP keys are supported");
  if (!RSA_ALGORITHMS.has(body[5])) throw new SignatureError("Only RSA keys are supported");

  const modulus = readMpi(body, 6);
  const exponent = readMpi(body, modulus.next);

  const fingerprint = crypto
    .createHash("sha1")
    .update(Buffer.from([0x99, (body.length >> 8) & 0xff, body.length & 0xff]))
    .update(body)
    .digest("hex")
    .toUpperCase();

  const key = crypto.createPublicKey({
    key: { kty: "RSA", n: toBase64Url(modulus.value), e: toBase64Url(exponent.value) },
    format: "jwk",
  });

  return { key, fingerprint, modulusBytes: modulus.value.length };
}

function readSubpackets(buffer) {
  const subpackets = [];
  let offset = 0;

  while (offset < buffer.length) {
    let length = buffer[offset];
    let headerSize = 1;
    if (length >= 192 && length < 255) {
      length = ((length - 192) << 8) + buffer[offset + 1] + 192;
      headerSize = 2;
    } else if (length === 255) {
      length = buffer.readUInt32BE(offset + 1);
      headerSize = 5;
    }

    const start = offset + headerSize;
    if (length < 1 || start + length > buffer.length) {
      throw new SignatureError("Malformed signature subpacket");
    }

    subpackets.push({ type: buffer[start] & 0x7f, data: buffer.subarray(start + 1, start + length) });
    offset = start + length;
  }

  return subpackets;
}

function parseSignature(signatureData) {
  const buffer = Buffer.isBuffer(signatureData) ? signatureData : dearmor(signatureData);
  const packets = readPackets(buffer).filter((item) => item.tag === SIGNATURE_TAG);
  if (packets.length !== 1) throw new SignatureError("Expected exactly one signature");

  const body = packets[0].body;
  if (body[0] !== 4) throw new SignatureError("Only v4 signatures are supported");

  const signatureType = body[1];
  const publicKeyAlgorithm = body[2];
  const hashAlgorithm = HASH_ALGORITHMS[body[3]];

  if (signatureType !== 0x00) throw new SignatureError("Unexpected signature type");
  if (!RSA_ALGORITHMS.has(publicKeyAlgorithm)) throw new SignatureError("Unsupported signature algorithm");
  if (!hashAlgorithm) throw new SignatureError("Unsupported signature hash algorithm");

  const hashedLength = body.readUInt16BE(4);
  const hashedEnd = 6 + hashedLength;
  const hashed = readSubpackets(body.subarray(6, hashedEnd));
  const unhashedLength = body.readUInt16BE(hashedEnd);
  const unhashedEnd = hashedEnd + 2 + unhashedLength;
  const hashPrefix = body.subarray(unhashedEnd, unhashedEnd + 2);
  const signature = readMpi(body, unhashedEnd + 2).value;

  const issuer = hashed.find((item) => item.type === ISSUER_FINGERPRINT_SUBPACKET);
  const created = hashed.find((item) => item.type === SIGNATURE_CREATION_SUBPACKET);

  return {
    hashAlgorithm,
    // The signed portion: version through the end of the hashed subpackets.
    hashedPortion: body.subarray(0, hashedEnd),
    hashPrefix,
    signature,
    issuerFingerprint:
      issuer && issuer.data[0] === 4 ? issuer.data.subarray(1).toString("hex").toUpperCase() : "",
    createdAt: created ? new Date(created.data.readUInt32BE(0) * 1000) : null,
  };
}

/**
 * Verifies a detached OpenPGP signature over `document` with the given key,
 * which must have the pinned fingerprint. Throws SignatureError on any
 * mismatch; returns { fingerprint, createdAt } when the signature is valid.
 */
function verifyDetachedSignature({ document, signature, publicKey, expectedFingerprint }) {
  const key = parsePublicKey(publicKey);
  const pinned = String(expectedFingerprint || "").replace(/\s+/g, "").toUpperCase();

  if (!pinned || key.fingerprint !== pinned) {
    throw new SignatureError("The signing key does not match the pinned fingerprint");
  }

  const parsed = parseSignature(signature);

  if (parsed.issuerFingerprint && parsed.issuerFingerprint !== key.fingerprint) {
    throw new SignatureError("The signature was made by a different key");
  }

  const documentBuffer = Buffer.isBuffer(document) ? document : Buffer.from(document);
  const trailer = Buffer.alloc(6);
  trailer[0] = 0x04;
  trailer[1] = 0xff;
  trailer.writeUInt32BE(parsed.hashedPortion.length, 2);
  const signedData = Buffer.concat([documentBuffer, parsed.hashedPortion, trailer]);

  const digest = crypto.createHash(parsed.hashAlgorithm).update(signedData).digest();
  if (!digest.subarray(0, 2).equals(parsed.hashPrefix)) {
    throw new SignatureError("The signature does not match the signed file");
  }

  // MPIs drop leading zero bytes; RSA verification needs the full length.
  const signatureBytes = Buffer.concat([
    Buffer.alloc(Math.max(0, key.modulusBytes - parsed.signature.length)),
    parsed.signature,
  ]);

  const valid = crypto.verify(
    parsed.hashAlgorithm,
    signedData,
    { key: key.key, padding: crypto.constants.RSA_PKCS1_PADDING },
    signatureBytes,
  );

  if (!valid) {
    throw new SignatureError("The signature does not match the signed file");
  }

  return { fingerprint: key.fingerprint, createdAt: parsed.createdAt };
}

module.exports = {
  SignatureError,
  parsePublicKey,
  parseSignature,
  verifyDetachedSignature,
};
