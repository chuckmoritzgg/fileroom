"""Independent check of the browser-side Web Push code (RFC 8291 decryption, RFC 8292 JWT).

    node tests/js/crypto.test.mjs /tmp/push.json && python tests/js/verify_push.py /tmp/push.json
"""
import base64
import json
import sys

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


v = json.load(open(sys.argv[1]))
body = unb64(v['request']['body'])
salt, rs, idlen = body[:16], int.from_bytes(body[16:20], 'big'), body[20]
as_public, ciphertext = body[21:21 + idlen], body[21 + idlen:]
assert rs == 4096 and idlen == 65 and len(body) <= 4096

jwk = v['uaPrivate']
private = ec.derive_private_key(int.from_bytes(unb64(jwk['d']), 'big'), ec.SECP256R1())
ua_public = unb64(v['uaPublic'])
shared = private.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))
ikm = hkdf(unb64(v['auth']), shared, b'WebPush: info\x00' + ua_public + as_public, 32)
cek = hkdf(salt, ikm, b'Content-Encoding: aes128gcm\x00', 16)
nonce = hkdf(salt, ikm, b'Content-Encoding: nonce\x00', 12)
plain = AESGCM(cek).decrypt(nonce, ciphertext, None)
assert plain[-1] == 2, 'missing last-record delimiter'
assert json.loads(plain[:-1]) == v['payload'], plain

# VAPID: "vapid t=<jwt>, k=<public key>"
token, key = v['request']['auth'][len('vapid t='):].split(', k=')
assert key == v['vapidPublic']
header, claims, signature = token.split('.')
assert json.loads(unb64(header)) == {'typ': 'JWT', 'alg': 'ES256'}
c = json.loads(unb64(claims))
assert c['aud'] == 'https://fcm.googleapis.com' and c['sub'] == 'https://fileroom.example' and c['exp'] > 0
sig = unb64(signature)
public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64(key))
public.verify(encode_dss_signature(int.from_bytes(sig[:32], 'big'), int.from_bytes(sig[32:], 'big')),
              f'{header}.{claims}'.encode(), ec.ECDSA(hashes.SHA256()))
print('push payload decrypts and the VAPID token verifies')
