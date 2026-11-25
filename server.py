"""小伴 · 网页版静态服务

只为 web/ 目录提供静态文件托管，监听平台注入的 PORT。
所有业务逻辑（认证 / 云数据库 / 模型调用）都在浏览器里通过云 SDK 完成。
"""
import os
import posixpath
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / 'web'


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # 无 history fallback：除了真实存在的静态文件，一律回 index.html
        rel = posixpath.normpath(path.split('?', 1)[0].split('#', 1)[0]).lstrip('/')
        target = (WEB_DIR / rel) if rel else (WEB_DIR / 'index.html')
        if target.is_dir():
            target = target / 'index.html'
        if not target.exists():
            target = WEB_DIR / 'index.html'
        return str(target)

    def end_headers(self):
        # 静态资源允许缓存，HTML 不缓存，避免改版后拿到旧页面
        if self.path.endswith(('.js', '.css', '.json')):
            self.send_header('Cache-Control', 'public, max-age=60')
        else:
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        print('%s - %s' % (self.address_string(), fmt % args), flush=True)


def main():
    port = int(os.getenv('PORT', '7860'))
    handler = partial(Handler, directory=str(WEB_DIR))
    server = ThreadingHTTPServer(('0.0.0.0', port), handler)
    print(f'serving {WEB_DIR} on 0.0.0.0:{port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
