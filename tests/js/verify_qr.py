"""Decode the QR matrices produced by qr.test.mjs with OpenCV (an independent reader).

    node tests/js/qr.test.mjs /tmp/qr.json && python tests/js/verify_qr.py /tmp/qr.json
"""
import json
import sys

import cv2
import numpy as np

detector = cv2.QRCodeDetector()
codes = json.load(open(sys.argv[1]))
for code in codes:
    rows = code['rows']
    size, quiet, scale = len(rows), 4, 8
    img = np.full((size + 2 * quiet, size + 2 * quiet), 255, np.uint8)
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == '1':
                img[y + quiet, x + quiet] = 0
    img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
    text, _, _ = detector.detectAndDecode(img)
    assert text == code['text'], f"version {(size - 17) // 4}: decoded {text!r}, expected {code['text']!r}"
print(f'{len(codes)} QR codes decoded correctly')
