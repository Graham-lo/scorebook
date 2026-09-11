#!/usr/bin/python3
"""Linux OCR adapter: explicit Tesseract 5, bounded stdin/stdout, no image files.

TSV protocol: https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html
The OCR provenance differs from Apple Vision; neither engine is a fallback.
"""
import csv
import io
import json
import os
import subprocess
import sys
import time
from PIL import Image, ImageOps, ImageStat


def observations(tsv):
    rows = list(csv.DictReader(io.StringIO(tsv), delimiter='\t'))
    page = next(row for row in rows if row['level'] == '1')
    width, height = float(page['width']), float(page['height'])
    if width <= 0 or height <= 0:
        raise ValueError('invalid_page_dimensions')
    result = []
    for row in rows:
        if row['level'] != '5' or not row.get('text', '').strip():
            continue
        confidence = float(row['conf']) / 100
        if confidence < 0:
            continue
        left, top, w, h = (float(row[key]) for key in ('left', 'top', 'width', 'height'))
        result.append({'text': row['text'][:512], 'confidence': min(1, confidence),
                       'box': [left / width, top / height, w / width, h / height]})
    return result[:256]


def main():
    engine = '/usr/bin/tesseract'
    version = subprocess.check_output([engine, '--version'], text=True, stderr=subprocess.DEVNULL).splitlines()[0]
    if not version.startswith('tesseract 5.'):
        raise RuntimeError('unsupported_ocr_engine')
    data = sys.stdin.buffer.read(20 * 1024 * 1024 + 1)
    if not data or len(data) > 20 * 1024 * 1024:
        raise ValueError('invalid_image_size')
    deadline = time.monotonic() + 20
    def recognize(payload):
        process = subprocess.run([engine, 'stdin', 'stdout', '-l', 'eng', '--psm', '11', 'tsv'],
                                 input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 env=dict(os.environ, OMP_THREAD_LIMIT='1'),
                                 timeout=max(.01, deadline - time.monotonic()), check=True)
        if len(process.stdout) > 2 * 1024 * 1024:
            raise ValueError('ocr_output_too_large')
        return observations(process.stdout.decode())
    # The title is read independently on every image: candle pixels must not
    # decide the title's binarization or page segmentation. Whole-image text
    # still participates in detecting nonstandard charts (Renko / Heikin).
    with Image.open(io.BytesIO(data)) as source:
        width, height = source.size
        if width > 8192 or height > 8192 or width * height > 32 * 1024 * 1024:
            raise ValueError('invalid_image_dimensions')
        header_height = max(1, round(height * .3))
        header = ImageOps.grayscale(source.crop((0, 0, width, header_height)))
        if ImageStat.Stat(header).mean[0] < 128:
            header = ImageOps.invert(header)
        if width <= 2048:
            header = header.resize((width * 2, header_height * 2), Image.Resampling.LANCZOS)
        encoded = io.BytesIO()
        header.save(encoded, format='PNG')
    title = recognize(encoded.getvalue())
    for item in title:
        item['box'][1] *= header_height / height
        item['box'][3] *= header_height / height
    result = (title + recognize(data))[:256]
    print(json.dumps({'model_id': 'tesseract-5-eng-v1', 'revision': 1,
                      'system_version': version, 'observations': result}))


if __name__ == '__main__':
    main()
