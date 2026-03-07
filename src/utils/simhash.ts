export function shingle(text: string, n: number = 3): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length < n) return [words.join(' ')];

  const shingles: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    shingles.push(words.slice(i, i + n).join(' '));
  }
  return shingles;
}

function hashString(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

export function computeSimHash(text: string): string {
  const shingles = shingle(text);
  const bits = new Array<number>(64).fill(0);

  for (const value of shingles) {
    const hash = hashString(value);
    for (let i = 0; i < 64; i++) {
      if (((hash >> BigInt(i)) & 1n) === 1n) {
        bits[i] += 1;
      } else {
        bits[i] -= 1;
      }
    }
  }

  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if (bits[i] > 0) {
      fingerprint |= 1n << BigInt(i);
    }
  }

  return fingerprint.toString(16).padStart(16, '0');
}

export function hammingDistance(hash1: string, hash2: string): number {
  const a = BigInt(`0x${hash1}`);
  const b = BigInt(`0x${hash2}`);
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

export function isNearDuplicate(hash1: string, hash2: string, threshold: number = 3): boolean {
  return hammingDistance(hash1, hash2) <= threshold;
}
