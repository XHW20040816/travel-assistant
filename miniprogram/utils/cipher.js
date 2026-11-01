/**
 * 本地敏感配置加密
 *
 * 算法：AES-128-CTR + SHA-256（纯 JS 实现，不依赖 npm）
 * 密文格式：v1:<hex(iv + ciphertext)>
 *
 * 说明：密钥由包内固定串 + 小程序 AppID 派生，能防止明文落盘与被随手读取，
 * 但客户端密钥无法做到真正意义上的“不可逆”，请勿用它存放服务端主密钥。
 */

const KEY_SECRET = 'TA-LLM-CIPHER-V1|'

const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]

function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

function sha256(input) {
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const len = input.length
  const total = (((len + 9) + 63) >> 6) << 6
  const msg = new Array(total).fill(0)
  for (let i = 0; i < len; i += 1) msg[i] = input[i]
  msg[len] = 0x80
  const bits = len * 8
  const hi = Math.floor(bits / 4294967296)
  const lo = bits % 4294967296
  msg[total - 8] = (hi >>> 24) & 0xff
  msg[total - 7] = (hi >>> 16) & 0xff
  msg[total - 6] = (hi >>> 8) & 0xff
  msg[total - 5] = hi & 0xff
  msg[total - 4] = (lo >>> 24) & 0xff
  msg[total - 3] = (lo >>> 16) & 0xff
  msg[total - 2] = (lo >>> 8) & 0xff
  msg[total - 1] = lo & 0xff

  const W = new Array(64)
  for (let offset = 0; offset < total; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      const i = offset + t * 4
      W[t] = ((msg[i] << 24) | (msg[i + 1] << 16) | (msg[i + 2] << 8) | msg[i + 3]) >>> 0
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = W[t - 15]
      const w2 = W[t - 2]
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0
    }

    let a = H[0]
    let b = H[1]
    let c = H[2]
    let d = H[3]
    let e = H[4]
    let f = H[5]
    let g = H[6]
    let h = H[7]

    for (let t = 0; t < 64; t += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (h + S1 + ch + SHA_K[t] + W[t]) >>> 0
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
    H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0
    H[7] = (H[7] + h) >>> 0
  }

  const out = []
  H.forEach((word) => {
    out.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff)
  })
  return out
}

function gfMul(a, b) {
  let result = 0
  let x = a & 0xff
  let y = b & 0xff
  for (let i = 0; i < 8; i += 1) {
    if (y & 1) result ^= x
    const high = x & 0x80
    x = (x << 1) & 0xff
    if (high) x ^= 0x1b
    y >>= 1
  }
  return result & 0xff
}

let sboxCache = null

function getSbox() {
  if (sboxCache) return sboxCache
  const box = new Array(256)
  for (let x = 0; x < 256; x += 1) {
    let inv = 0
    if (x) {
      let base = x
      let exp = 254
      inv = 1
      while (exp) {
        if (exp & 1) inv = gfMul(inv, base)
        base = gfMul(base, base)
        exp >>= 1
      }
    }
    let s = inv
    for (let shift = 1; shift <= 4; shift += 1) {
      s ^= ((inv << shift) | (inv >>> (8 - shift))) & 0xff
    }
    box[x] = (s ^ 0x63) & 0xff
  }
  sboxCache = box
  return box
}

function expandKey(keyBytes) {
  const words = []
  for (let i = 0; i < 4; i += 1) words.push(keyBytes.slice(i * 4, i * 4 + 4))
  const sbox = getSbox()
  let rcon = 1
  for (let i = 4; i < 44; i += 1) {
    let temp = words[i - 1].slice()
    if (i % 4 === 0) {
      temp = [temp[1], temp[2], temp[3], temp[0]].map((value) => sbox[value])
      temp[0] ^= rcon
      rcon = gfMul(rcon, 2)
    }
    words.push(words[i - 4].map((value, index) => value ^ temp[index]))
  }
  return words
}

function addRoundKey(state, words, round) {
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      state[row + col * 4] ^= words[round * 4 + col][row]
    }
  }
}

function subBytes(state) {
  const sbox = getSbox()
  for (let i = 0; i < 16; i += 1) state[i] = sbox[state[i]]
}

function shiftRows(state) {
  for (let row = 1; row < 4; row += 1) {
    const line = [state[row], state[row + 4], state[row + 8], state[row + 12]]
    for (let col = 0; col < 4; col += 1) {
      state[row + col * 4] = line[(col + row) % 4]
    }
  }
}

function mixColumns(state) {
  for (let col = 0; col < 4; col += 1) {
    const i = col * 4
    const a0 = state[i]
    const a1 = state[i + 1]
    const a2 = state[i + 2]
    const a3 = state[i + 3]
    state[i] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3
    state[i + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3
    state[i + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3)
    state[i + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2)
  }
}

function encryptBlock(block, words) {
  const state = block.slice()
  addRoundKey(state, words, 0)
  for (let round = 1; round < 10; round += 1) {
    subBytes(state)
    shiftRows(state)
    mixColumns(state)
    addRoundKey(state, words, round)
  }
  subBytes(state)
  shiftRows(state)
  addRoundKey(state, words, 10)
  return state
}

function ctrCrypt(bytes, keyBytes, ivBytes) {
  const words = expandKey(keyBytes)
  const out = new Array(bytes.length)
  const counter = ivBytes.slice()
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const stream = encryptBlock(counter, words)
    for (let i = 0; i < 16 && offset + i < bytes.length; i += 1) {
      out[offset + i] = bytes[offset + i] ^ stream[i]
    }
    for (let i = 15; i >= 0; i -= 1) {
      counter[i] = (counter[i] + 1) & 0xff
      if (counter[i]) break
    }
  }
  return out
}

function utf8ToBytes(text) {
  const bytes = []
  const str = String(text)
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
      i += 1
    }
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return bytes
}

function bytesToUtf8(bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]
    if (byte < 0x80) {
      text += String.fromCharCode(byte)
    } else if (byte < 0xe0) {
      text += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
      i += 1
    } else if (byte < 0xf0) {
      text += String.fromCharCode(((byte & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f))
      i += 2
    } else {
      const code = ((byte & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)
      i += 3
      if (code > 0xffff) {
        const offset = code - 0x10000
        text += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff))
      } else {
        text += String.fromCharCode(code)
      }
    }
  }
  return text
}

function toHex(bytes) {
  let hex = ''
  bytes.forEach((byte) => {
    const value = (byte & 0xff).toString(16)
    hex += value.length === 1 ? `0${value}` : value
  })
  return hex
}

function fromHex(hex) {
  const bytes = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16))
  }
  return bytes
}

function appId() {
  try {
    if (typeof wx === 'undefined' || typeof wx.getAccountInfoSync !== 'function') return ''
    const info = wx.getAccountInfoSync()
    return (info && info.miniProgram && info.miniProgram.appId) || ''
  } catch (err) {
    return ''
  }
}

function deriveKey() {
  return sha256(utf8ToBytes(`${KEY_SECRET}${appId() || 'unknown-app'}`)).slice(0, 16)
}

function randomIv() {
  const iv = []
  let seed = (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0
  for (let i = 0; i < 16; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0
    iv.push((seed >>> 16) & 0xff)
  }
  return iv
}

/** 加密文本，返回 v1:<hex> */
function encryptText(text) {
  const iv = randomIv()
  const cipher = ctrCrypt(utf8ToBytes(text), deriveKey(), iv)
  return `v1:${toHex(iv)}${toHex(cipher)}`
}

/** 解密文本，失败返回空串 */
function decryptText(blob) {
  const raw = String(blob || '')
  if (raw.indexOf('v1:') !== 0) return ''
  const hex = raw.slice(3)
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return ''
  const bytes = fromHex(hex)
  if (bytes.length < 17) return ''
  const iv = bytes.slice(0, 16)
  const data = bytes.slice(16)
  try {
    return bytesToUtf8(ctrCrypt(data, deriveKey(), iv))
  } catch (err) {
    return ''
  }
}

function isEncrypted(blob) {
  return /^v1:[0-9a-fA-F]+$/.test(String(blob || ''))
}

module.exports = {
  encryptText,
  decryptText,
  isEncrypted,
  sha256: (text) => sha256(utf8ToBytes(text)),
  utf8ToBytes,
  bytesToUtf8
}
