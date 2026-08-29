#!/usr/bin/env python3
"""Python<->Node integration smoke test.

Stubs the minimal `sublime` API surface, then drives the REAL MdServerProcess
code path: node discovery, spawn, MDP1 startup-line parsing, POST /render,
GET /p/<slug>, and shutdown. Catches protocol drift between the Python client
and the Node sidecar without needing a running Sublime Text.
"""
import http.client
import json
import os
import shutil
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
PLUGIN_DIR = os.path.join(PKG_ROOT, 'plugin')

CACHE_DIR = os.path.join(tempfile.gettempdir(), 'mdpreview-py-smoke')
os.makedirs(CACHE_DIR, exist_ok=True)


class FakeSettings(object):
    def __init__(self, overrides=None):
        self.overrides = overrides or {}

    def get(self, key, default=None):
        return self.overrides.get(key, default)


def install_sublime_stub():
    stub = types.ModuleType('sublime')
    stub.platform = lambda: 'osx'
    stub.cache_path = lambda: CACHE_DIR
    stub.load_settings = lambda name: FakeSettings()
    sys.modules['sublime'] = stub


def check(name, condition, actual=None):
    if condition:
        print('  ok %s' % name)
    else:
        print('  FAIL %s%s' % (name, (' — got: %r' % (actual,)) if actual is not None else ''))
        sys.exit(1)


def main():
    install_sublime_stub()
    sys.path.insert(0, PLUGIN_DIR)

    from mdpreview.render import collect_options, preview_width_value
    from mdpreview.server import MdServerError, MdServerProcess, _version_tuple

    # --- pure helpers ---------------------------------------------------------
    check('version tuple parses v-prefixed', _version_tuple('v22.22.2') == (22, 22, 2))
    check('version tuple pads missing parts', _version_tuple('20') == (20, 0, 0))
    check('preview_width adaptive default', preview_width_value(FakeSettings()) == 'adaptive')
    check('preview_width numeric passthrough', preview_width_value(FakeSettings({'preview_width': 375})) == 375)
    check('preview_width invalid falls back', preview_width_value(FakeSettings({'preview_width': 'bogus'})) == 'adaptive')
    check('preview_width out of range falls back', preview_width_value(FakeSettings({'preview_width': 10})) == 'adaptive')

    options = collect_options(FakeSettings({
        'theme': 'grace',
        'heading_styles': {'h1': 'border-bottom', 'bogus-level': 'color-only'},
        'custom_css': '  h1 { letter-spacing: 1px }  ',
    }))
    check('snake->camel mapping', options.get('theme') == 'grace' and options.get('primaryColor') == '#0F4C81'
          and options.get('isMacCodeBlock') is True and options.get('inlineStyles') is False, options)
    check('heading_styles filtered to h1-h6', options.get('headingStyles') == {'h1': 'border-bottom'})
    check('custom_css trimmed and included', options.get('customCSS') == 'h1 { letter-spacing: 1px }')

    empty = collect_options(FakeSettings())
    check('defaults carry over', empty.get('fontSize') == '16px' and empty.get('legend') == 'alt')

    # --- live sidecar round-trip ----------------------------------------------
    manager = MdServerProcess()
    ok, error = manager.ensure_running()
    check('sidecar started', ok, error)
    if not ok:
        raise SystemExit(error)

    with open(os.path.join(HERE, 'fixture.md'), encoding='utf-8') as handle:
        markdown = handle.read()

    payload = {
        'id': 'pytest-1',
        'markdown': markdown,
        'title': 'py-client 冒烟',
        'pollMs': 500,
        'previewWidth': 375,
        'options': collect_options(FakeSettings({'count_status': True})),
    }
    result = manager.render(payload)
    check('render round-trip', result.get('ok') is True and result.get('rev') == 1, result)
    check('preview url returned', str(result.get('url', '')).startswith('/p/'), result.get('url'))

    conn = http.client.HTTPConnection('127.0.0.1', manager.port, timeout=30)
    conn.request('GET', result['url'])
    response = conn.getresponse()
    document = response.read().decode('utf-8')
    conn.close()
    check('preview document served', response.status == 200 and document.startswith('<!DOCTYPE html>'))
    check('previewWidth 375 served', 'width: 375px' in document and 'max-width: 960px' not in document)
    check('mermaid preview embeds source for browser hydration',
          'data-mermaid-src="' in document and '/vendor/mermaid.mjs' in document)
    check('cjk survives the round-trip', '一级标题' in document and 'mac-sign' in document)
    check('reading stats included', '阅读' in document or '字数' in document)

    second = manager.render(dict(payload, markdown='# 更新\n'))
    check('revision increments', second.get('rev') == 2, second.get('rev'))

    copy = manager.render(dict(payload, returnHtml=True, options=collect_options(FakeSettings({'inline_styles': True}))))
    html = copy.get('html') or ''
    check('returnHtml + juice inlining', '<section' in html and 'style="' in html)

    manager.shutdown()
    check('sidecar shut down', manager._proc is None)

    print('\npy-client smoke: all checks passed')


if __name__ == '__main__':
    main()
